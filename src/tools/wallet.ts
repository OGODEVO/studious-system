import { ethers } from "ethers";
import { config } from "../utils/config.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || "";

const NETWORK_PRESETS = {
    base: {
        chainId: 8453n,
        rpcUrl: "https://mainnet.base.org",
    },
    ethereum: {
        chainId: 1n,
        rpcUrl: "https://ethereum-rpc.publicnode.com",
    },
} as const;

type SupportedNetwork = keyof typeof NETWORK_PRESETS;

function resolveWalletConfig(): {
    network: SupportedNetwork;
    expectedChainId: bigint;
    rpcUrl: string;
} {
    const rawNetwork = String(config.walletNetwork || "base").toLowerCase();
    const network: SupportedNetwork =
        rawNetwork === "ethereum" ? "ethereum" : "base";

    const preset = NETWORK_PRESETS[network];
    const expectedChainId =
        config.walletExpectedChainId !== undefined
            ? BigInt(config.walletExpectedChainId)
            : preset.chainId;
    const rpcUrl = config.walletRpcUrl || preset.rpcUrl;

    return { network, expectedChainId, rpcUrl };
}

const WALLET_CFG = resolveWalletConfig();
const RPC_URL = WALLET_CFG.rpcUrl;
const MAX_SEND_GAS_RESERVE_ETH = Number(process.env.OASIS_MAX_SEND_GAS_RESERVE_ETH || "0.00015");

let provider: ethers.JsonRpcProvider;
let wallet: ethers.Wallet;

function ensureWallet() {
    if (!PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set in .env");
    if (!provider) provider = new ethers.JsonRpcProvider(RPC_URL);
    if (!wallet) wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    return wallet;
}

async function ensureNetworkMatch(): Promise<ethers.Network> {
    ensureWallet();
    const network = await provider.getNetwork();
    if (network.chainId !== WALLET_CFG.expectedChainId) {
        throw new Error(
            `Wallet network mismatch: configured=${WALLET_CFG.network} expectedChainId=${WALLET_CFG.expectedChainId.toString()} actualChainId=${network.chainId.toString()} rpc=${RPC_URL}`
        );
    }
    return network;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Returns the wallet's public address */
export async function getAddress(): Promise<string> {
    const w = ensureWallet();
    return w.address;
}

/** Returns ETH balance (or ERC-20 balance if token address provided) */
export async function getBalance(tokenAddress?: string): Promise<string> {
    const w = ensureWallet();
    const network = await ensureNetworkMatch();

    if (tokenAddress) {
        const erc20 = new ethers.Contract(
            tokenAddress,
            ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"],
            provider
        );
        const [balance, symbol, decimals] = await Promise.all([
            erc20.balanceOf(w.address),
            erc20.symbol(),
            erc20.decimals(),
        ]);
        return `${ethers.formatUnits(balance, decimals)} ${symbol} (network=${WALLET_CFG.network} chainId=${network.chainId.toString()} rpc=${RPC_URL})`;
    }

    const balance = await provider.getBalance(w.address);
    return `${ethers.formatEther(balance)} ETH (network=${WALLET_CFG.network} chainId=${network.chainId.toString()} rpc=${RPC_URL})`;
}

export async function normalizeSendAmount(
    amountRaw: string,
    tokenAddress?: string
): Promise<string> {
    if (typeof amountRaw !== "string" || !amountRaw.trim()) {
        throw new Error("Amount is required.");
    }
    const normalizedInput = amountRaw.trim().toLowerCase();
    const isMaxKeyword =
        normalizedInput === "max" ||
        normalizedInput === "all" ||
        normalizedInput === "maximum";

    if (isMaxKeyword) {
        const w = ensureWallet();
        await ensureNetworkMatch();

        if (tokenAddress) {
            const erc20 = new ethers.Contract(
                tokenAddress,
                [
                    "function balanceOf(address) view returns (uint256)",
                    "function decimals() view returns (uint8)",
                ],
                provider
            );
            const [balance, decimals] = await Promise.all([
                erc20.balanceOf(w.address),
                erc20.decimals(),
            ]);
            if (balance <= 0n) throw new Error("Insufficient token balance for max send.");
            return ethers.formatUnits(balance, decimals);
        }

        const balance = await provider.getBalance(w.address);
        const reserveWei = ethers.parseEther(MAX_SEND_GAS_RESERVE_ETH.toString());
        if (balance <= reserveWei) {
            throw new Error(
                `Insufficient ETH for max send after gas reserve (${MAX_SEND_GAS_RESERVE_ETH} ETH).`
            );
        }
        const sendableWei = balance - reserveWei;
        return ethers.formatEther(sendableWei);
    }

    const numeric = normalizedInput.match(/^(\d+(?:\.\d+)?)(?:\s*eth)?$/i);
    if (!numeric) {
        throw new Error(
            "Invalid amount. Use a numeric value (e.g. 0.005) or 'max'."
        );
    }

    return numeric[1];
}

export function normalizeRecipientAddress(toRaw: string): string {
    if (typeof toRaw !== "string" || !toRaw.trim()) {
        throw new Error("Recipient address is required.");
    }
    if (!ethers.isAddress(toRaw.trim())) {
        throw new Error("Invalid recipient address.");
    }
    return ethers.getAddress(toRaw.trim());
}

export async function getNetworkStatus(): Promise<string> {
    const network = await ensureNetworkMatch();
    const latest = await provider.getBlockNumber();
    return `network=${WALLET_CFG.network} chainId=${network.chainId.toString()} expectedChainId=${WALLET_CFG.expectedChainId.toString()} block=${latest} rpc=${RPC_URL}`;
}

export async function getTransactionStatus(txHash: string): Promise<string> {
    ensureWallet();
    const hash = txHash.trim();
    if (!/^0x([A-Fa-f0-9]{64})$/.test(hash)) {
        throw new Error("Invalid transaction hash format.");
    }

    const [network, tx, receipt] = await Promise.all([
        ensureNetworkMatch(),
        provider.getTransaction(hash),
        provider.getTransactionReceipt(hash),
    ]);

    if (!tx) {
        return `Not found on configured RPC. network=${WALLET_CFG.network} chainId=${network.chainId.toString()} rpc=${RPC_URL}`;
    }

    const valueEth = ethers.formatEther(tx.value);
    const status =
        receipt?.status === 1
            ? "success"
            : receipt?.status === 0
                ? "failed"
                : "pending";
    const block = tx.blockNumber ?? receipt?.blockNumber ?? "pending";

    return [
        `hash=${hash}`,
        `network=${WALLET_CFG.network}`,
        `chainId=${network.chainId.toString()}`,
        `rpc=${RPC_URL}`,
        `status=${status}`,
        `from=${tx.from}`,
        `to=${tx.to || "(contract creation)"}`,
        `value=${valueEth} ETH`,
        `block=${block}`,
    ].join("\n");
}

/** Send ETH or ERC-20 token. Returns tx hash. */
export async function sendTransaction(
    to: string,
    amount: string,
    tokenAddress?: string
): Promise<string> {
    const w = ensureWallet();
    await ensureNetworkMatch();

    if (tokenAddress) {
        const erc20 = new ethers.Contract(
            tokenAddress,
            ["function transfer(address, uint256) returns (bool)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"],
            w
        );
        const decimals = await erc20.decimals();
        const value = ethers.parseUnits(amount, decimals);
        const tx = await erc20.transfer(to, value);
        await tx.wait();
        return tx.hash;
    }

    const tx = await w.sendTransaction({
        to,
        value: ethers.parseEther(amount),
    });
    await tx.wait();
    return tx.hash;
}

/**
 * Call any smart contract function (read or write).
 * @param contractAddress - The contract's address
 * @param abi - A JSON ABI fragment (array of function definitions)
 * @param functionName - Which function to call
 * @param args - Arguments to pass
 * @param value - Optional ETH value to send (for payable functions)
 */
export async function callContract(
    contractAddress: string,
    abi: string,
    functionName: string,
    args: string[] = [],
    value?: string
): Promise<string> {
    const w = ensureWallet();
    await ensureNetworkMatch();
    const parsedAbi = JSON.parse(abi);
    const contract = new ethers.Contract(contractAddress, parsedAbi, w);

    const fn = contract[functionName];
    if (!fn) throw new Error(`Function "${functionName}" not found in ABI`);

    // Detect if this is a read (view/pure) or write call
    const fragment = contract.interface.getFunction(functionName);
    if (!fragment) throw new Error(`Function "${functionName}" not in interface`);

    const isReadOnly = fragment.stateMutability === "view" || fragment.stateMutability === "pure";

    if (isReadOnly) {
        const result = await fn(...args);
        return `Result: ${result.toString()}`;
    } else {
        const overrides: any = {};
        if (value) overrides.value = ethers.parseEther(value);
        const tx = await fn(...args, overrides);
        await tx.wait();
        return `TX hash: ${tx.hash}`;
    }
}
