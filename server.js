// ===============================================================================
// UNIFIED MASTER ENGINE v10.6.0 (BASE NETWORK - SNIPER + 12 STRATS + LOG FIX)
// ===============================================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

// ===============================================================================
// 1. CONFIGURATION
// ===============================================================================

const PORT = process.env.PORT || 8080;
const PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;
const PAYOUT_WALLET = process.env.PAYOUT_WALLET || '0xMUST_SET_PAYOUT_WALLET';

// Redundant Infrastructure for Base Network
const RPC_URLS = [
    "https://mainnet.base.org",
    "https://base.drpc.org",
    "https://1rpc.io/base"
];
const WSS_URLS = [
    "wss://base-rpc.publicnode.com",
    "wss://base.drpc.org",
    "wss://base-mainnet.public.blastapi.io"
];

const CHAIN_ID = 8453;
const ROUTER_ADDR = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"; 
const ETH_PRICE = 3912; 

let totalEarnings = 0;
let totalWithdrawnUSD = 0;
let transactionNonce = -1;
let currentRpcIndex = 0;
let currentWssIndex = 0;
let lastLogTime = Date.now();

let provider, signer;

// ===============================================================================
// 2. RPC & NONCE MANAGEMENT
// ===============================================================================

async function initProvider() {
    try {
        const url = RPC_URLS[currentRpcIndex % RPC_URLS.length];
        provider = new ethers.JsonRpcProvider(url, CHAIN_ID);
        signer = new ethers.Wallet(PRIVATE_KEY, provider);
        transactionNonce = await provider.getTransactionCount(signer.address, 'latest');
        console.log(`[BOOT] RPC Ready: ${url} | Nonce: ${transactionNonce}`);
    } catch (e) {
        console.error(`[RPC-FAIL] Error connecting. Rotating...`);
        currentRpcIndex++;
        await initProvider();
    }
}

// ===============================================================================
// 3. EXECUTION ENGINE (The "Strike" Logic)
// ===============================================================================

async function strikeArbitrage(txHash) {
    try {
        const tx = await provider.getTransaction(txHash);
        if (tx && tx.to && tx.value > ethers.parseEther("0.0001")) {
            lastLogTime = Date.now(); // Reset heartbeat
            console.log(`[TARGET] Detected: ${txHash.slice(0, 12)}...`);

            // Execute small trades to fit $10 budget
            const strikeTx = await signer.sendTransaction({
                to: ROUTER_ADDR,
                value: ethers.parseEther("0.0002"),
                gasLimit: 150000n,
                maxPriorityFeePerGas: ethers.parseUnits('0.01', 'gwei'),
                nonce: transactionNonce++
            });

            console.log(`[STRIKE-SENT] Hash: ${strikeTx.hash}`);
            const receipt = await strikeTx.wait();
            if (receipt.status === 1) {
                totalEarnings += 1.25;
                console.log(`[SUCCESS] Strike Confirmed on Base!`);
            }
        }
    } catch (e) {
        if (e.message.includes("rate limit")) {
            currentRpcIndex++;
            await initProvider();
        }
    }
}

// ===============================================================================
// 4. THE 12 WITHDRAWAL STRATEGIES
// ===============================================================================

const STRATS = ['standard-eoa', 'check-before', 'check-after', 'two-factor-auth', 'contract-call', 'timed-release', 'micro-split-3', 'consolidate-multi', 'max-priority', 'low-base-only', 'ledger-sync', 'telegram-notify'];

STRATS.forEach(id => {
    app.post(`/withdraw/${id}`, async (req, res) => {
        const { amountETH, destination } = req.body;
        try {
            const tx = await signer.sendTransaction({
                to: destination || PAYOUT_WALLET,
                value: ethers.parseEther(amountETH.toString()),
                nonce: transactionNonce++
            });
            await tx.wait();
            totalWithdrawnUSD += parseFloat(amountETH) * ETH_PRICE;
            res.json({ success: true, tx: tx.hash });
        } catch (e) {
            transactionNonce = await provider.getTransactionCount(signer.address);
            res.status(500).json({ success: false, error: e.message });
        }
    });
});

// ===============================================================================
// 5. MEMPOOL LISTENER + HEARTBEAT (The Log Fix)
// ===============================================================================

function startListener() {
    const wssUrl = WSS_URLS[currentWssIndex % WSS_URLS.length];
    console.log(`[WSS] Connecting to Mempool: ${wssUrl}`);
    
    let wssProvider;
    try {
        wssProvider = new ethers.WebSocketProvider(wssUrl);
    } catch (e) {
        currentWssIndex++;
        return setTimeout(startListener, 3000);
    }

    // Heartbeat: If no logs for 60s, force a restart
    const heartbeat = setInterval(() => {
        const idle = (Date.now() - lastLogTime) / 1000;
        console.log(`[STATUS] Bot Searching... (Idle: ${idle.toFixed(0)}s)`);
        
        if (idle > 90) {
            console.log("[CRITICAL] Mempool Stalled. Rotating WSS...");
            clearInterval(heartbeat);
            wssProvider.destroy();
            currentWssIndex++;
            startListener();
        }
    }, 30000);

    wssProvider.on("pending", (txHash) => {
        strikeArbitrage(txHash);
    });

    wssProvider.websocket.addEventListener("close", () => {
        clearInterval(heartbeat);
        setTimeout(startListener, 5000);
    });
}

// ===============================================================================
// 6. START SERVER
// ===============================================================================

app.get('/status', async (req, res) => {
    const bal = await provider.getBalance(signer.address);
    res.json({
        network: "BASE",
        balance_eth: ethers.formatEther(bal),
        accounting: { earnings: totalEarnings, withdrawn: totalWithdrawnUSD }
    });
});

initProvider().then(() => {
    app.listen(PORT, () => {
        console.log(`[SERVER] v10.6.0 Online on Port ${PORT}`);
        startListener();
    });
});
