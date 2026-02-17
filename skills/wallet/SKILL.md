---
id: wallet
name: ETH Wallet
description: Check balances, send ETH/tokens, and interact with smart contracts on-chain.
triggers:
  - wallet
  - balance
  - send eth
  - send token
  - transfer
  - check balance
  - my address
  - smart contract
  - call contract
  - swap
  - on-chain
  - erc20
  - nft
priority: 90
inputs:
  - recipient address
  - amount
  - token contract address
  - ABI fragment
outputs:
  - wallet address
  - balance
  - transaction hash
  - contract call result
safety_notes:
  - All send/write operations ALWAYS require explicit Telegram approval
  - Read-only contract calls (view/pure) execute freely
  - Never expose the private key in responses
---

# Wallet Skill

Use this skill for anything involving the agent's ETH wallet, on-chain queries, or smart contract interaction.

## Tools Available

**wallet_address** — Returns the agent's public address. No params needed.

**wallet_balance** — Checks ETH balance. Pass an optional `token` (ERC-20 contract address) to check a specific token.

**wallet_send** — Sends ETH or an ERC-20 token. Params: `to`, `amount`, optional `token`. Always requires approval.

**wallet_call_contract** — Calls any smart contract function. Params: `contract_address`, `abi` (JSON ABI fragment), `function_name`, optional `args` and `value`. Write calls require approval; reads are free.

## Guidelines

- When the user asks about balances, use `wallet_balance`.
- When the user asks to send crypto, use `wallet_send` and clearly state the amount and recipient before executing.
- For smart contract interactions, construct the minimal ABI fragment needed for the specific function call.
- Never reveal the private key or seed phrase.
- If you don't know a token's contract address, use the browser to look it up first.
- Always confirm transaction details with the user before calling any write function.

## Common Patterns

**Check ETH balance:**
Call `wallet_balance` with no params.

**Check USDC balance on Base:**
Call `wallet_balance` with `token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"` (USDC on Base).

**Send ETH:**
Call `wallet_send` with `to` and `amount`.

**Read a contract:**
Call `wallet_call_contract` with the contract address, a minimal ABI fragment like `[{"name":"balanceOf","type":"function","stateMutability":"view","inputs":[{"name":"account","type":"address"}],"outputs":[{"name":"","type":"uint256"}]}]`, the function name, and args.
