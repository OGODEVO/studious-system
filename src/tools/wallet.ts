import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RPC_URL = process.env.ETH_RPC_URL || "https://mainnet.base.org";
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || "";

let provider: ethers.JsonRpcProvider;
let wallet: ethers.Wallet;

function ensureWallet() {
    if (!PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set in .env");
    if (!provider) provider = new ethers.JsonRpcProvider(RPC_URL);
    if (!wallet) wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    return wallet;
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
        return `${ethers.formatUnits(balance, decimals)} ${symbol}`;
    }

    const balance = await provider.getBalance(w.address);
    return `${ethers.formatEther(balance)} ETH`;
}

/** Send ETH or ERC-20 token. Returns tx hash. */
export async function sendTransaction(
    to: string,
    amount: string,
    tokenAddress?: string
): Promise<string> {
    const w = ensureWallet();

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
