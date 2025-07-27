import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import fs from "fs";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { DirectSecp256k1Wallet } from "@cosmjs/proto-signing"; 
import pkg from "@cosmjs/stargate";
const { GasPrice, coins } = pkg;
import pkgCosmwasm from "@cosmjs/cosmwasm-stargate";
const { SigningCosmWasmClient } = pkgCosmwasm;

const RPC_URL = "https://rpc.zigscan.net";
const API_URL = "https://testnet-api.oroswap.org/api";
const CONFIG_FILE = "config.json";
const ORO_ZIG_CONTRACT = "zig15jqg0hmp9n06q0as7uk3x9xkwr9k3r7yh4ww2uc0hek8zlryrgmsamk4qg";
const ZIG_BEE_CONTRACT = "zig1r50m5lafnmctat4xpvwdpzqndynlxt2skhr4fhzh76u0qar2y9hqu74u5h";
const DENOM_ORO = "coin.zig10rfjm85jmzfhravjwpq3hcdz8ngxg7lxd0drkr.uoro";
const DENOM_ZIG = "uzig";
const DENOM_BEE = "coin.zig1ptxpjgl3lsxrq99zl6ad2nmrx4lhnhne26m6ys.bee";
const GAS_PRICE = GasPrice.fromString("0.03uzig");
const NETWORK_NAME = "OroSwap Testnet";
const TOKEN_DECIMALS = {
  "uzig": 6,
  "coin.zig10rfjm85jmzfhravjwpq3hcdz8ngxg7lxd0drkr.uoro": 6,
  "coin.zig1ptxpjgl3lsxrq99zl6ad2nmrx4lhnhne26m6ys.bee": 6
};

const isDebug = false;

let walletInfo = {
  address: "N/A",
  balanceZIG: "0.0000",
  balanceORO: "0.0000",
  balanceBEE: "0.0000",
  points: "0",
  activeAccount: "N/A"
};
let transactionLogs = [];
let swapRunning = false;
let swapCancelled = false;
let isCycleRunning = false;
let dailyActivityInterval = null;
let privateKeys = []; 
let proxies = [];
let selectedWalletIndex = 0;
let lastSwapDirectionZigOro = "ORO_TO_ZIG";
let lastSwapDirectionZigBee = "BEE_TO_ZIG";
let loadingSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const borderBlinkColors = ["cyan", "blue", "magenta", "red", "yellow", "green"];
let borderBlinkIndex = 0;
let blinkCounter = 0;
let spinnerIndex = 0;
let activeProcesses = 0;
let hasLoggedSleepInterrupt = false;
let isHeaderRendered = false;

let dailyActivityConfig = {
  swapRepetitions: 1,
  addLpRepetitions: 1,
  randomAmountRanges: {
    "ZIG_ORO": { ZIG: { min: 0.001, max: 0.002 }, ORO: { min: 0.001, max: 0.002 } },
    "ZIG_BEE": { ZIG: { min: 1, max: 2 }, BEE: { min: 0.001, max: 0.003 } }
  },
  addLpOroRange: { min: 0.5, max: 1.0 }
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const config = JSON.parse(data);
      dailyActivityConfig.swapRepetitions = Number(config.swapRepetitions) || 1;
      dailyActivityConfig.addLpRepetitions = Number(config.addLpRepetitions) || 1;
      dailyActivityConfig.randomAmountRanges = config.randomAmountRanges || dailyActivityConfig.randomAmountRanges;
      dailyActivityConfig.addLpOroRange = config.addLpOroRange || { min: 0.5, max: 1.0 };
    } else {
      addLog("No config file found, using default settings.", "info");
    }
  } catch (error) {
    addLog(`Failed to load config: ${error.message}`, "error");
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
    addLog("Configuration saved successfully.", "success");
  } catch (error) {
    addLog(`Failed to save config: ${error.message}`, "error");
  }
}

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function getShortHash(hash) {
  return hash ? hash.slice(0, 6) + "..." + hash.slice(-4) : "N/A";
}

function addLog(message, type = "info") {
  if (type === "debug" && !isDebug) return;
  const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let coloredMessage;
  switch (type) {
    case "error": coloredMessage = chalk.redBright(message); break;
    case "success": coloredMessage = chalk.greenBright(message); break;
    case "wait": coloredMessage = chalk.yellowBright(message); break;
    case "info": coloredMessage = chalk.whiteBright(message); break;
    case "swap": coloredMessage = chalk.cyanBright(message); break;
    case "system": coloredMessage = chalk.whiteBright(message); break;
    default: coloredMessage = chalk.white(message);
  }
  const logMessage = `[${timestamp}] ${coloredMessage}`;
  transactionLogs.push(logMessage);
  updateLogs();
}

function clearTransactionLogs() {
  transactionLogs = [];
  logBox.setContent('');
  logBox.scrollTo(0);
  addLog("Transaction logs cleared.", "success");
}

function loadPrivateKeys() { 
  try {
    const data = fs.readFileSync("pk.txt", "utf8");
    privateKeys = data.split("\n").map(pk => pk.trim()).filter(pk => pk);
    if (privateKeys.length === 0) throw new Error("No valid private keys in pk.txt");
    addLog(`Loaded ${privateKeys.length} private keys from pk.txt`, "success");
  } catch (error) {
    addLog(`Failed to load private keys: ${error.message}`, "error");
    privateKeys = [];
  }
}

function loadProxies() {
  try {
    if (fs.existsSync("proxy.txt")) {
      const data = fs.readFileSync("proxy.txt", "utf8");
      proxies = data.split("\n").map(proxy => proxy.trim()).filter(proxy => proxy);
      if (proxies.length === 0) throw new Error("No proxy found in proxy.txt");
      addLog(`Loaded ${proxies.length} proxies from proxy.txt`, "success");
    } else {
      addLog("No proxy.txt found, running without proxy.", "info");
    }
  } catch (error) {
    addLog(`Failed to load proxy: ${error.message}`, "info");
    proxies = [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) return new SocksProxyAgent(proxyUrl);
  return new HttpsProxyAgent(proxyUrl);
}

async function getCosmosClient(privateKey, proxyUrl) { 
  try {
    const wallet = await DirectSecp256k1Wallet.fromKey(Buffer.from(privateKey, 'hex'), "zig");
    const clientOptions = proxyUrl ? { httpClient: { agent: createAgent(proxyUrl) } } : {};
    const client = await SigningCosmWasmClient.connectWithSigner(RPC_URL, wallet, { gasPrice: GAS_PRICE, ...clientOptions });
    return { client, wallet };
  } catch (error) {
    addLog(`Failed to initialize Cosmos client: ${error.message}`, "error");
    throw error;
  }
}

async function sleep(ms) {
  if (swapCancelled) {
    if (!hasLoggedSleepInterrupt) {
      addLog("Process stopped successfully.", "info");
      hasLoggedSleepInterrupt = true;
    }
    return;
  }
  activeProcesses++;
  try {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(), ms);
      const checkStop = setInterval(() => {
        if (swapCancelled) {
          clearTimeout(timeout);
          clearInterval(checkStop);
          if (!hasLoggedSleepInterrupt) {
            addLog("Process interrupted.", "info");
            hasLoggedSleepInterrupt = true;
          }
          resolve();
        }
      }, 100);
    });
  } catch (error) {
    addLog(`Sleep error: ${error.message}`, "error");
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

async function getBalance(client, address, denom) {
  try {
    const balance = await client.getBalance(address, denom);
    return Number(balance.amount / Math.pow(10, TOKEN_DECIMALS[denom])).toFixed(4);
  } catch (error) {
    addLog(`Failed to fetch balance for ${denom}: ${error.message}`, "error");
    return "0.0000";
  }
}

async function getPoints(address) {
  try {
    const response = await axios.get(`${API_URL}/portfolio/${address}/points`, {
      headers: {
        accept: "application/json",
        "accept-language": "en-US,en;q=0.7",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        Referer: "https://testnet.oroswap.org/",
      },
    });
    return String(response.data.points[0]?.points || "0");
  } catch (error) {
    addLog(`Failed to fetch points for ${getShortAddress(address)}: ${error.message}`, "error");
    return "0";
  }
}

async function getPoolInfo(client, contractAddress) {
  try {
    const poolInfo = await client.queryContractSmart(contractAddress, { pool: {} });
    return poolInfo;
  } catch (error) {
    addLog(`Failed to get pool info for contract ${contractAddress}: ${error.message}`, "error");
    return null;
  }
}

function toMicroUnits(amount, denom) {
  const decimals = TOKEN_DECIMALS[denom] || 6;
  return Math.floor(parseFloat(amount) * Math.pow(10, decimals));
}

function calculateBeliefPrice(poolInfo, fromDenom, toDenom) {
  try {
    if (!poolInfo || !poolInfo.assets || poolInfo.assets.length !== 2) {
      addLog(`Invalid pool info for ${fromDenom} ➯ ${toDenom}, cannot calculate belief price`, "error");
      throw new Error("Invalid pool info");
    }

    const asset1 = poolInfo.assets[0];
    const asset2 = poolInfo.assets[1];
    const denom1 = asset1.info.native_token?.denom || asset1.info.token?.contract_addr;
    const denom2 = asset2.info.native_token?.denom || asset2.info.token?.contract_addr;

    let amountFrom, amountTo;
    if (fromDenom === denom1 && toDenom === denom2) {
      amountFrom = parseFloat(asset1.amount);
      amountTo = parseFloat(asset2.amount);
    } else if (fromDenom === denom2 && toDenom === denom1) {
      amountFrom = parseFloat(asset2.amount);
      amountTo = parseFloat(asset1.amount);
    } else {
      addLog(`Pool does not match swap assets for ${fromDenom} ➯ ${toDenom}`, "error");
      throw new Error("Mismatched pool assets");
    }

    if (amountFrom <= 0 || amountTo <= 0) {
      addLog(`Invalid pool amounts for ${fromDenom} ➯ ${toDenom}`, "error");
      throw new Error("Invalid pool amounts");
    }

    const beliefPrice = (amountFrom / amountTo).toFixed(18);
    addLog(`Calculated belief_price for ${fromDenom} ➯ ${toDenom}: ${beliefPrice}`, "debug");
    return beliefPrice;
  } catch (error) {
    addLog(`Failed to calculate belief price for ${fromDenom} ➯ ${toDenom}: ${error.message}`, "error");
    throw error;
  }
}

async function addLiquidityOroZig(client, address, oroAmount) {
  try {
    const poolInfo = await getPoolInfo(client, ORO_ZIG_CONTRACT);
    if (!poolInfo || !poolInfo.assets || poolInfo.assets.length !== 2) {
      throw new Error("Invalid pool info for ORO-ZIG");
    }
    const asset1 = poolInfo.assets[0];
    const asset2 = poolInfo.assets[1];
    const asset1Denom = asset1.info.native_token?.denom || asset1.info.token?.contract_addr;
    const asset2Denom = asset2.info.native_token?.denom || asset2.info.token?.contract_addr;
    let oroInPool, zigInPool;
    if (asset1Denom === DENOM_ORO) {
      oroInPool = parseInt(asset1.amount);
      zigInPool = parseInt(asset2.amount);
    } else {
      oroInPool = parseInt(asset2.amount);
      zigInPool = parseInt(asset1.amount);
    }
    if (oroInPool <= 0 || zigInPool <= 0) {
      throw new Error("Invalid pool amounts for ORO-ZIG");
    }
    const oroMicro = toMicroUnits(oroAmount, DENOM_ORO);
    const zigMicroNeeded = Math.floor((oroMicro * zigInPool) / oroInPool);
    const msg = {
      provide_liquidity: {
        assets: [
          { amount: oroMicro.toString(), info: { native_token: { denom: DENOM_ORO } } },
          { amount: zigMicroNeeded.toString(), info: { native_token: { denom: DENOM_ZIG } } }
        ],
        auto_stake: false,
        slippage_tolerance: "0.5"
      }
    };
    const funds = [
      { denom: DENOM_ORO, amount: oroMicro.toString() },
      { denom: DENOM_ZIG, amount: zigMicroNeeded.toString() }
    ];
    addLog(`Adding liquidity: ${oroAmount} ORO and ${(zigMicroNeeded / 1e6).toFixed(6)} ZIG`, "swap");
    const result = await client.execute(address, ORO_ZIG_CONTRACT, msg, "auto", "Add Liquidity ORO-ZIG", funds);
        const shortTxHash = getShortHash(result.transactionHash);
    addLog(`Add LP completed! Tx: ${shortTxHash}`, "success");
    return result;
  } catch (error) {
    addLog(`Add LP failed: ${error.message}`, "error");
    return null;
  }
}

async function updateWalletData() {
  const walletDataPromises = privateKeys.map(async (privateKey, i) => { 
    try {
      const proxyUrl = proxies[i % proxies.length] || null;
      const { client, wallet } = await getCosmosClient(privateKey, proxyUrl); 
      const [account] = await wallet.getAccounts();
      const address = account.address;
      const zigBalance = await getBalance(client, address, DENOM_ZIG);
      const oroBalance = await getBalance(client, address, DENOM_ORO);
      const beeBalance = await getBalance(client, address, DENOM_BEE);
      const points = await getPoints(address);
      const formattedEntry = `${i === selectedWalletIndex ? "→ " : "  "}${chalk.bold.magentaBright(getShortAddress(address))}  ${chalk.bold.cyanBright(zigBalance.padEnd(4))}   ${chalk.bold.cyanBright(oroBalance.padEnd(4))}  ${chalk.bold.cyanBright(beeBalance.padEnd(4))} ${chalk.bold.yellowBright(points.padEnd(6))}`;
      if (i === selectedWalletIndex) {
        walletInfo.address = address;
        walletInfo.activeAccount = `Account ${i + 1}`;
        walletInfo.balanceZIG = zigBalance;
        walletInfo.balanceORO = oroBalance;
        walletInfo.balanceBEE = beeBalance;
        walletInfo.points = points;
      }
      return formattedEntry;
    } catch (error) {
      addLog(`Failed to fetch wallet data for account #${i + 1}: ${error.message}`, "error");
      return null;
    }
  });
  try {
    const walletData = (await Promise.all(walletDataPromises)).filter(entry => entry !== null);
    addLog("Wallet data updated.", "success");
    return walletData;
  } catch (error) {
    addLog(`Wallet data update failed: ${error.message}`, "error");
    return [];
  }
}

async function performSwap(client, address, fromDenom, toDenom, amount, swapNumber, totalSwaps, contractAddress) {
  try {
    const microAmount = toMicroUnits(amount, fromDenom);
    const fromSymbol = fromDenom === DENOM_ZIG ? "ZIG" : fromDenom === DENOM_ORO ? "ORO" : "BEE";
    const toSymbol = toDenom === DENOM_ZIG ? "ZIG" : toDenom === DENOM_ORO ? "ORO" : "BEE";
    const poolInfo = await getPoolInfo(client, contractAddress);
    const beliefPrice = calculateBeliefPrice(poolInfo, fromDenom, toDenom);
    const msg = {
      swap: {
        belief_price: beliefPrice,
        max_spread: "0.5",
        offer_asset: { amount: microAmount.toString(), info: { native_token: { denom: fromDenom } } }
      }
    };
    const funds = coins(microAmount, fromDenom);
    addLog(`Swap ${swapNumber} of ${totalSwaps}: ${amount} ${fromSymbol} ➯ ${toSymbol}`, "swap");
    const result = await client.execute(address, contractAddress, msg, "auto", `Swap ${fromSymbol} to ${toSymbol}`, funds);
    const shortTxHash = getShortHash(result.transactionHash);
    addLog(`Swap ${swapNumber} completed! Tx: ${shortTxHash}`, "success");
    return result;
  } catch (error) {
    addLog(`Swap ${swapNumber} failed: ${error.message}`, "error");
    return null;
  }
}

async function autoSwapZigOro(client, address, totalSwaps, swapNumber) {
  try {
    const zigBalance = parseFloat(await getBalance(client, address, DENOM_ZIG));
    const oroBalance = parseFloat(await getBalance(client, address, DENOM_ORO));
    const zigAmount = (Math.random() * (dailyActivityConfig.randomAmountRanges["ZIG_ORO"].ZIG.max - dailyActivityConfig.randomAmountRanges["ZIG_ORO"].ZIG.min) + dailyActivityConfig.randomAmountRanges["ZIG_ORO"].ZIG.min).toFixed(4);
    const oroAmount = (Math.random() * (dailyActivityConfig.randomAmountRanges["ZIG_ORO"].ORO.max - dailyActivityConfig.randomAmountRanges["ZIG_ORO"].ORO.min) + dailyActivityConfig.randomAmountRanges["ZIG_ORO"].ORO.min).toFixed(4);

    if (lastSwapDirectionZigOro === "ORO_TO_ZIG") {
      addLog(`Checking ORO ➯ ZIG swap: Need ${oroAmount} ORO, Available ${oroBalance} ORO`, "info");
      if (oroBalance >= oroAmount) {
        addLog(`Performing ORO ➯ ZIG swap with ${oroAmount} ORO`, "swap");
        await performSwap(client, address, DENOM_ORO, DENOM_ZIG, oroAmount, swapNumber, totalSwaps, ORO_ZIG_CONTRACT);
        lastSwapDirectionZigOro = "ZIG_TO_ORO";
        return true;
      } else {
        addLog(`Insufficient ORO balance: ${oroBalance} < ${oroAmount}. Trying ZIG ➯ ORO`, "wait");
        if (zigBalance >= zigAmount) {
          addLog(`Performing ZIG ➯ ORO swap with ${zigAmount} ZIG`, "swap");
          await performSwap(client, address, DENOM_ZIG, DENOM_ORO, zigAmount, swapNumber, totalSwaps, ORO_ZIG_CONTRACT);
          lastSwapDirectionZigOro = "ORO_TO_ZIG";
          return true;
        } else {
          addLog(`Insufficient ZIG balance: ${zigBalance} < ${zigAmount}`, "wait");
          return false;
        }
      }
    } else {
      addLog(`Checking ZIG ➯ ORO swap: Need ${zigAmount} ZIG, Available ${zigBalance} ZIG`, "info");
      if (zigBalance >= zigAmount) {
        addLog(`Performing ZIG ➯ ORO swap with ${zigAmount} ZIG`, "swap");
        await performSwap(client, address, DENOM_ZIG, DENOM_ORO, zigAmount, swapNumber, totalSwaps, ORO_ZIG_CONTRACT);
        lastSwapDirectionZigOro = "ORO_TO_ZIG";
        return true;
      } else {
        addLog(`Insufficient ZIG balance: ${zigBalance} < ${zigAmount}. Trying ORO ➯ ZIG`, "wait");
        if (oroBalance >= oroAmount) {
          addLog(`Performing ORO ➯ ZIG swap with ${oroAmount} ORO`, "swap");
          await performSwap(client, address, DENOM_ORO, DENOM_ZIG, oroAmount, swapNumber, totalSwaps, ORO_ZIG_CONTRACT);
          lastSwapDirectionZigOro = "ZIG_TO_ORO";
          return true;
        } else {
          addLog(`Insufficient ORO balance: ${oroBalance} < ${oroAmount}`, "wait");
          return false;
        }
      }
    }
  } catch (error) {
    addLog(`Failed to perform ZIG-ORO swap: ${error.message}`, "error");
    return false;
  }
}

async function autoSwapZigBee(client, address, totalSwaps, swapNumber) {
  try {
    const zigBalance = parseFloat(await getBalance(client, address, DENOM_ZIG));
    const beeBalance = parseFloat(await getBalance(client, address, DENOM_BEE));
    const zigAmount = (Math.random() * (dailyActivityConfig.randomAmountRanges["ZIG_BEE"].ZIG.max - dailyActivityConfig.randomAmountRanges["ZIG_BEE"].ZIG.min) + dailyActivityConfig.randomAmountRanges["ZIG_BEE"].ZIG.min).toFixed(4);
    const beeAmount = (Math.random() * (dailyActivityConfig.randomAmountRanges["ZIG_BEE"].BEE.max - dailyActivityConfig.randomAmountRanges["ZIG_BEE"].BEE.min) + dailyActivityConfig.randomAmountRanges["ZIG_BEE"].BEE.min).toFixed(4);

    if (lastSwapDirectionZigBee === "BEE_TO_ZIG") {
      addLog(`Checking BEE ➯ ZIG swap: Need ${beeAmount} BEE, Available ${beeBalance} BEE`, "info");
      if (beeBalance >= beeAmount) {
        addLog(`Performing BEE ➯ ZIG swap with ${beeAmount} BEE`, "swap");
        await performSwap(client, address, DENOM_BEE, DENOM_ZIG, beeAmount, swapNumber, totalSwaps, ZIG_BEE_CONTRACT);
        lastSwapDirectionZigBee = "ZIG_TO_BEE";
        return true;
      } else {
        addLog(`Insufficient BEE balance: ${beeBalance} < ${beeAmount}. Trying ZIG ➯ BEE`, "wait");
        if (zigBalance >= zigAmount) {
          addLog(`Performing ZIG ➯ BEE swap with ${zigAmount} ZIG`, "swap");
          await performSwap(client, address, DENOM_ZIG, DENOM_BEE, zigAmount, swapNumber, totalSwaps, ZIG_BEE_CONTRACT);
          lastSwapDirectionZigBee = "BEE_TO_ZIG";
          return true;
        } else {
          addLog(`Insufficient ZIG balance: ${zigBalance} < ${zigAmount}`, "wait");
          return false;
        }
      }
    } else {
      addLog(`Checking ZIG ➯ BEE swap: Need ${zigAmount} ZIG, Available ${zigBalance} ZIG`, "info");
      if (zigBalance >= zigAmount) {
        addLog(`Performing ZIG ➯ BEE swap with ${zigAmount} ZIG`, "swap");
        await performSwap(client, address, DENOM_ZIG, DENOM_BEE, zigAmount, swapNumber, totalSwaps, ZIG_BEE_CONTRACT);
        lastSwapDirectionZigBee = "BEE_TO_ZIG";
        return true;
      } else {
        addLog(`Insufficient ZIG balance: ${zigBalance} < ${zigAmount}. Trying BEE ➯ ZIG`, "wait");
        if (beeBalance >= beeAmount) {
          addLog(`Performing BEE ➯ ZIG swap with ${beeAmount} BEE`, "swap");
          await performSwap(client, address, DENOM_BEE, DENOM_ZIG, beeAmount, swapNumber, totalSwaps, ZIG_BEE_CONTRACT);
          lastSwapDirectionZigBee = "ZIG_TO_BEE";
          return true;
        } else {
          addLog(`Insufficient BEE balance: ${beeBalance} < ${beeAmount}`, "warning");
          return false;
        }
      }
    }
  } catch (error) {
    addLog(`Failed to perform ZIG-BEE swap: ${error.message}`, "error");
    return false;
  }
}

async function runDailyActivity() {
  if (privateKeys.length === 0) { 
    addLog("No valid private keys found.", "error");
    return;
  }
  addLog(`Starting daily activity for all accounts. Auto Swap: ${dailyActivityConfig.swapRepetitions}x | Add LP: ${dailyActivityConfig.addLpRepetitions}x`, "info");
  swapRunning = true;
  isCycleRunning = true;
  swapCancelled = false;
  activeProcesses = Math.max(0, activeProcesses);
  updateMenu();
  try {
    for (let accountIndex = 0; accountIndex < privateKeys.length && !swapCancelled; accountIndex++) { 
      addLog(`Starting processing for account ${accountIndex + 1}`, "info");
      selectedWalletIndex = accountIndex;
      const proxyUrl = proxies[accountIndex % proxies.length] || null;
      let client, wallet;
      addLog(`Account ${accountIndex + 1}: Using Proxy ${proxyUrl || "none"}`, "info");
      try {
        ({ client, wallet } = await getCosmosClient(privateKeys[accountIndex], proxyUrl)); 
      } catch (error) {
        addLog(`Failed to connect to Cosmos client for account ${accountIndex + 1}: ${error.message}`, "error");
        continue;
      }
      const [account] = await wallet.getAccounts();
      const address = account.address;
      addLog(`Processing account ${accountIndex + 1}: ${getShortAddress(address)}`, "wait");

      for (let swapCount = 0; swapCount < dailyActivityConfig.swapRepetitions && !swapCancelled; swapCount++) {
        const pair = Math.random() < 0.5 ? "ZIG_ORO" : "ZIG_BEE";
        const autoSwapFunction = pair === "ZIG_ORO" ? autoSwapZigOro : autoSwapZigBee;
        try {
          const success = await autoSwapFunction(client, address, dailyActivityConfig.swapRepetitions, swapCount + 1);
          if (success) await updateWallets();
          if (swapCount < dailyActivityConfig.swapRepetitions - 1 || accountIndex < privateKeys.length - 1) { 
            const randomDelay = Math.floor(Math.random() * (60000 - 30000 + 1)) + 30000;
            addLog(`Account ${accountIndex + 1} - Waiting ${Math.floor(randomDelay / 1000)} seconds before next swap...`, "info");
            await sleep(randomDelay);
          } else {
            addLog(`Account ${accountIndex + 1} - No delay needed after final swap.`, "debug");
          }
        } catch (error) {
          addLog(`Account ${accountIndex + 1} - Swap ${swapCount + 1}: Failed: ${error.message}`, "error");
        }
      }

      if (!swapCancelled) {
        for (let lpCount = 0; lpCount < dailyActivityConfig.addLpRepetitions && !swapCancelled; lpCount++) {
          const oroBalance = parseFloat(await getBalance(client, address, DENOM_ORO));
          const zigBalance = parseFloat(await getBalance(client, address, DENOM_ZIG));
          const minOro = dailyActivityConfig.addLpOroRange.min;
          const maxOro = dailyActivityConfig.addLpOroRange.max;
          const oroAmount = (Math.random() * (maxOro - minOro) + minOro).toFixed(6);
          const poolInfo = await getPoolInfo(client, ORO_ZIG_CONTRACT);

          if (poolInfo && poolInfo.assets && poolInfo.assets.length === 2) {
            const asset1 = poolInfo.assets[0];
            const asset2 = poolInfo.assets[1];
            const asset1Denom = asset1.info.native_token?.denom || asset1.info.token?.contract_addr;
            const asset2Denom = asset2.info.native_token?.denom || asset2.info.token?.contract_addr;
            let oroInPool = asset1Denom === DENOM_ORO ? parseInt(asset1.amount) / 1e6 : parseInt(asset2.amount) / 1e6;
            let zigInPool = asset1Denom === DENOM_ZIG ? parseInt(asset1.amount) / 1e6 : parseInt(asset2.amount) / 1e6;

            if (oroInPool > 0 && zigInPool > 0) {
              const ratio = zigInPool / oroInPool;
              const zigNeeded = oroAmount * ratio;

              if (oroBalance >= oroAmount && zigBalance >= zigNeeded) {
                await addLiquidityOroZig(client, address, oroAmount);
                await updateWallets();
                if (lpCount < dailyActivityConfig.addLpRepetitions - 1) {
                  const randomDelay = Math.floor(Math.random() * (60000 - 30000 + 1)) + 30000;
                  addLog(`Account ${accountIndex + 1} - Waiting ${Math.floor(randomDelay / 1000)} seconds before next Add LP...`, "info");
                  await sleep(randomDelay);
                }
              } else {
                addLog(`Insufficient balance for Add LP ${lpCount + 1}: ORO ${oroBalance} < ${oroAmount} or ZIG ${zigBalance} < ${zigNeeded}`, "wait");
              }
            } else {
              addLog(`Invalid pool amounts for ORO-ZIG, skipping Add LP ${lpCount + 1}`, "wait");
            }
          } else {
            addLog(`Failed to get pool info for ORO-ZIG, skipping Add LP ${lpCount + 1}`, "wait");
          }
        }
      }

      if (accountIndex < privateKeys.length - 1 && !swapCancelled) { 
        addLog(`Waiting 10 seconds before next account...`, "info");
        await sleep(10000);
      }
    }
    if (!swapCancelled && activeProcesses <= 0) {
      addLog("All accounts processed. Waiting 24 hours for next cycle.", "success");
      dailyActivityInterval = setTimeout(runDailyActivity, 24 * 60 * 60 * 1000);
    }
  } catch (error) {
    addLog(`Daily activity failed: ${error.message}`, "error");
  } finally {
    swapRunning = false;
    isCycleRunning = activeProcesses > 0 || dailyActivityInterval !== null;
    updateMenu();
    swapCancelled = false;
    hasLoggedSleepInterrupt = false;
    activeProcesses = 0;
    safeRender();
  }
}

const screen = blessed.screen({
  smartCSR: true,
  title: "OROSWAP AUTO BOT",
  autoPadding: true,
  fullUnicode: true,
  mouse: true,
  ignoreLocked: ["C-c", "q", "escape"]
});

const headerBox = blessed.box({ top: 0, left: "center", width: "100%", height: 6, tags: true, style: { fg: "yellow", bg: "default" } });
const statusBox = blessed.box({ left: 0, top: 6, width: "100%", height: 3, tags: true, border: { type: "line", fg: "cyan" }, style: { fg: "white", bg: "default", border: { fg: "cyan" } }, content: "Status: Initializing...", padding: { left: 1, right: 1, top: 0, bottom: 0 }, label: chalk.cyan(" Status "), wrap: true });
const walletBox = blessed.list({ label: " Wallet Information", top: 9, left: 0, width: "40%", height: Math.floor(screen.height * 0.35) - 2, border: { type: "line", fg: "cyan" }, style: { border: { fg: "cyan" }, fg: "white", bg: "default", item: { fg: "white" } }, scrollable: true, scrollbar: { bg: "cyan", fg: "black" }, padding: { left: 1, right: 1, top: 0, bottom: 0 }, tags: true, keys: true, vi: true, mouse: true, content: "Loading wallet data..." });
const logBox = blessed.log({ label: " Transaction Logs", top: 9, left: "41%", width: "60%", height: "100%-9", border: { type: "line" }, scrollable: true, alwaysScroll: true, mouse: true, tags: true, scrollbar: { ch: "│", style: { bg: "cyan", fg: "white" }, track: { bg: "gray" } }, scrollback: 100, smoothScroll: true, style: { border: { fg: "magenta" }, bg: "default", fg: "white" }, padding: { left: 1, right: 1, top: 0, bottom: 0 }, wrap: true, focusable: true, keys: true });
const mainMenu = blessed.list({ label: " Menu ", top: "44%", left: 0, width: "40%", height: "56%", keys: true, vi: true, mouse: true, border: { type: "line" }, style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "magenta", fg: "black" }, item: { fg: "white" } }, items: getMainMenuItems(), padding: { left: 1, top: 1 } });
const manualConfigSubMenu = blessed.list({
  label: " Manual Config Options ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "blue" }, selected: { bg: "blue", fg: "black" }, item: { fg: "white" } },
  items: ["Set Swap Repetitions", "Set Random Amount ZIG & ORO", "Set Random Amount ZIG & BEE", "Set Add LP ORO Range", "Set Add LP Repetitions", "Back to Main Menu"],
  padding: { left: 1, top: 1 },
  hidden: true
});
const promptBox = blessed.prompt({ parent: screen, border: "line", height: 5, width: "60%", top: "center", left: "center", label: "{bright-blue-fg}Prompt{/bright-blue-fg}", tags: true, keys: true, vi: true, mouse: true, style: { fg: "white", bg: "default", border: { fg: "red" } }, hidden: true });

screen.append(headerBox);
screen.append(statusBox);
screen.append(walletBox);
screen.append(logBox);
screen.append(mainMenu);
screen.append(manualConfigSubMenu);
screen.append(promptBox);

let renderQueue = [];
let isRendering = false;
function safeRender() {
  renderQueue.push(true);
  if (isRendering) return;
  isRendering = true;
  setTimeout(() => {
    try {
      if (!isHeaderRendered) {
        figlet.text("NT EXHAUST", { font: "ANSI Shadow" }, (err, data) => {
          if (!err) headerBox.setContent(`{center}{bold}{cyan-fg}${data}{/cyan-fg}{/bold}{/center}`);
          isHeaderRendered = true;
        });
      }
      screen.render();
    } catch (error) {
      addLog(`UI render error: ${error.message}`, "error");
    }
    renderQueue.shift();
    isRendering = false;
    if (renderQueue.length > 0) safeRender();
  }, 100);
}

function adjustLayout() {
  const screenHeight = screen.height || 24;
  const screenWidth = screen.width || 80;
  headerBox.height = Math.max(6, Math.floor(screenHeight * 0.15));
  statusBox.top = headerBox.height;
  statusBox.height = Math.max(3, Math.floor(screenHeight * 0.07));
  walletBox.top = headerBox.height + statusBox.height;
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35) - 2;
  logBox.top = headerBox.height + statusBox.height;
  logBox.left = Math.floor(screenWidth * 0.41);
  logBox.width = Math.floor(screenWidth * 0.6);
  logBox.height = screenHeight - (headerBox.height + statusBox.height);
  mainMenu.top = headerBox.height + statusBox.height + walletBox.height;
  mainMenu.width = Math.floor(screenWidth * 0.4);
  mainMenu.height = screenHeight - (headerBox.height + statusBox.height + walletBox.height);
  manualConfigSubMenu.top = mainMenu.top;
  manualConfigSubMenu.width = mainMenu.width;
  manualConfigSubMenu.height = mainMenu.height;
  manualConfigSubMenu.left = mainMenu.left;
  safeRender();
}

function updateStatus() {
  const isProcessing = swapRunning || (isCycleRunning && dailyActivityInterval !== null);
  const status = swapRunning ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Running")}` : isCycleRunning && dailyActivityInterval !== null ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Waiting for next cycle")}` : chalk.green("Idle");
  const statusText = `Status: ${status} | Active Account: ${getShortAddress(walletInfo.address)} | Total Accounts: ${privateKeys.length} | Auto Swap: ${dailyActivityConfig.swapRepetitions}x | Add LP: ${dailyActivityConfig.addLpRepetitions}x | OROSWAP AUTO BOT`; 
  statusBox.setContent(statusText);
  if (isProcessing) {
    if (blinkCounter % 1 === 0) {
      statusBox.style.border.fg = borderBlinkColors[borderBlinkIndex];
      borderBlinkIndex = (borderBlinkIndex + 1) % borderBlinkColors.length;
    }
    blinkCounter++;
  } else {
    statusBox.style.border.fg = "cyan";
  }
  spinnerIndex = (spinnerIndex + 1) % loadingSpinner.length;
  safeRender();
}

async function updateWallets() {
  const walletData = await updateWalletData();
  const header = `${chalk.bold.cyan("    Address").padEnd(12)}        ${chalk.bold.cyan("ZIG".padEnd(4))}     ${chalk.bold.cyan("ORO".padEnd(4))}    ${chalk.bold.cyan("BEE".padEnd(4))}  ${chalk.bold.cyan("Points".padEnd(8))}`;
  const separator = chalk.gray("-".repeat(60));
  walletBox.setItems([header, separator, ...walletData]);
  walletBox.select(0);
  safeRender();
}

function updateLogs() {
  logBox.add(transactionLogs[transactionLogs.length - 1] || chalk.gray("No logs available."));
  safeRender();
}

function getMainMenuItems() {
  return (swapRunning || isCycleRunning) ? ["Stop Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"] : ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"];
}

function updateMenu() {
  mainMenu.setItems(getMainMenuItems());
  safeRender();
}

const statusInterval = setInterval(updateStatus, 100);

logBox.key(["up"], () => { if (screen.focused === logBox) { logBox.scroll(-1); safeRender(); } });
logBox.key(["down"], () => { if (screen.focused === logBox) { logBox.scroll(1); safeRender(); } });
logBox.on("click", () => { screen.focusPush(logBox); logBox.style.border.fg = "yellow"; mainMenu.style.border.fg = "red"; manualConfigSubMenu.style.border.fg = "blue"; safeRender(); });
logBox.on("blur", () => { logBox.style.border.fg = "magenta"; safeRender(); });

mainMenu.on("select", async (item) => {
  const action = item.getText();
  switch (action) {
    case "Start Auto Daily Activity":
      if (swapRunning || isCycleRunning) {
        addLog("Daily Activity: A transaction is already running.Stop it first.", "warning");
      } else {
        addLog("Starting Auto Daily Activity", "info");
        await runDailyActivity();
      }
      break;
    case "Stop Activity":
      swapCancelled = true;
      if (dailyActivityInterval) {
        clearTimeout(dailyActivityInterval);
        dailyActivityInterval = null;
        addLog("Cleared daily activity interval.", "info");
      }
      addLog("Stopping daily activity. Please wait for ongoing process to complete.", "info");
      break;
    case "Set Manual Config":
      mainMenu.hide();
      manualConfigSubMenu.show();
      manualConfigSubMenu.focus();
      safeRender();
      break;
    case "Clear Logs":
      clearTransactionLogs();
      break;
    case "Refresh":
      await updateWallets();
      addLog("Data refreshed.", "success");
      break;
    case "Exit":
      clearInterval(statusInterval);
      process.exit(0);
  }
});

manualConfigSubMenu.on("select", (item) => {
  const action = item.getText();
  switch (action) {
    case "Set Swap Repetitions":
      promptBox.setFront();
      promptBox.input("Masukkan jumlah swap repetisi: ", dailyActivityConfig.swapRepetitions.toString(), (err, value) => {
        promptBox.hide();
        safeRender();
        if (err || !value) {
          addLog("Set Swap Repetitions: Input dibatalkan.", "error");
          manualConfigSubMenu.show();
          manualConfigSubMenu.focus();
          safeRender();
          return;
        }
        const swapRepetitions = parseInt(value);
        if (isNaN(swapRepetitions) || swapRepetitions <= 0) {
          addLog("Set Swap Repetitions: Input harus berupa angka positif.", "error");
          manualConfigSubMenu.show();
          manualConfigSubMenu.focus();
          safeRender();
          return;
        }
        dailyActivityConfig.swapRepetitions = swapRepetitions;
        saveConfig();
        addLog(`Swap Repetitions set to ${swapRepetitions}`, "success");
        updateStatus();
        manualConfigSubMenu.show();
        manualConfigSubMenu.focus();
        safeRender();
      });
      break;
    case "Set Random Amount ZIG & ORO":
      promptBox.setFront();
      promptBox.input(`Masukkan rentang random amount untuk ZIG pada pasangan ZIG & ORO (format: min,max, contoh: 0.001,0.002): `, "", (err, valueZig) => {
        promptBox.hide();
        safeRender();
        if (err || !valueZig) {
          addLog(`Set Random Amount: Input untuk ZIG pada ZIG & ORO dibatalkan.`, "system");
          manualConfigSubMenu.show();
          manualConfigSubMenu.focus();
          safeRender();
          return;
        }
        const [minZig, maxZig] = valueZig.split(",").map(v => parseFloat(v.trim()));
        if (isNaN(minZig) || isNaN(maxZig) || minZig <= 0 || maxZig <= minZig) {
          addLog(`Set Random Amount: Input tidak valid untuk ZIG pada ZIG & ORO. Gunakan format min,max (contoh: 0.001,0.002) dengan min > 0 dan max > min.`, "error");
          manualConfigSubMenu.show();
          manualConfigSubMenu.focus();
          safeRender();
          return;
        }
        promptBox.setFront();
        promptBox.input(`Masukkan rentang random amount untuk ORO pada pasangan ZIG & ORO (format: min,max, contoh: 0.001,0.002): `, "", (err, valueOro) => {
          promptBox.hide();
          safeRender();
          if (err || !valueOro) {
            addLog(`Set Random Amount: Input untuk ORO pada ZIG & ORO dibatalkan.`, "system");
            manualConfigSubMenu.show();
            manualConfigSubMenu.focus();
            safeRender();
            return;
          }
          const [minOro, maxOro] = valueOro.split(",").map(v => parseFloat(v.trim()));
          if (isNaN(minOro) || isNaN(maxOro) || minOro <= 0 || maxOro <= minZig) {
            addLog(`Set Random Amount: Input tidak valid untuk ORO pada ZIG & ORO. Gunakan format min,max (contoh: 0.001,0.002) dengan min > 0 dan max > min.`, "error");
            manualConfigSubMenu.show();
            manualConfigSubMenu.focus();
            safeRender();
            return;
          }
          dailyActivityConfig.randomAmountRanges["ZIG_ORO"] = { ZIG: { min: minZig, max: maxZig }, ORO: { min: minOro, max: maxOro } };
          saveConfig();
          addLog(`Set Random Amount: Random Amount ZIG & ORO diubah menjadi ZIG: ${minZig} - ${maxZig}, ORO: ${minOro} - ${maxOro}.`, "success");
          manualConfigSubMenu.show();
          manualConfigSubMenu.focus();
          safeRender();
        });
      });
      break;
    case "Set Random Amount ZIG & BEE":
      promptBox.setFront();
      promptBox.input(`Masukkan rentang random amount untuk ZIG pada pasangan ZIG & BEE (format: min,max, contoh: 1,2): `, "", (err, valueZig) => {
        promptBox.hide();
        safeRender();
        if (err || !valueZig) {
          addLog(`Set Random Amount: Input untuk ZIG pada ZIG & BEE dibatalkan.`, "system");
          manualConfigSubMenu.show();
          manualConfigSubMenu.focus();
          safeRender();
          return;
        }
        const [minZig, maxZig] = valueZig.split(",").map(v => parseFloat(v.trim()));
        if (isNaN(minZig) || isNaN(maxZig) || minZig <= 0 || maxZig <= minZig) {
          addLog(`Set Random Amount: Input tidak valid untuk ZIG pada ZIG & BEE. Gunakan format min,max (contoh: 1,2) dengan min > 0 dan max > min.`, "error");
          manualConfigSubMenu.show();
          manualConfigSubMenu.focus();
          safeRender();
          return;
        }
        promptBox.setFront();
        promptBox.input(`Masukkan rentang random amount untuk BEE pada pasangan ZIG & BEE (format: min,max, contoh: 0.001,0.003): `, "", (err, valueBee) => {
          promptBox.hide();
          safeRender();
          if (err || !valueBee) {
            addLog(`Set Random Amount: Input untuk BEE pada ZIG & BEE dibatalkan.`, "system");
            manualConfigSubMenu.show();
            manualConfigSubMenu.focus();
            safeRender();
            return;
          }
          const [minBee, maxBee] = valueBee.split(",").map(v => parseFloat(v.trim()));
          if (isNaN(minBee) || isNaN(maxBee) || minBee <= 0 || maxBee <= minZig) {
            addLog(`Set Random Amount: Input tidak valid untuk BEE pada ZIG & BEE. Gunakan format min,max (contoh: 0.001,0.003) dengan min > 0 dan max > min.`, "error");
            manualConfigSubMenu.show();
            manualConfigSubMenu.focus();
            safeRender();
            return;
          }
          dailyActivityConfig.randomAmountRanges["ZIG_BEE"] = { ZIG: { min: minZig, max: maxZig }, BEE: { min: minBee, max: maxBee } };
          saveConfig();
          addLog(`Set Random Amount: Random Amount ZIG & BEE diubah menjadi ZIG: ${minZig} - ${maxZig}, BEE: ${minBee} - ${maxBee}.`, "success");
          manualConfigSubMenu.show();
          manualConfigSubMenu.focus();
          safeRender();
        });
      });
      break;
    case "Set Add LP ORO Range":
      promptBox.setFront();
      promptBox.input(`Masukkan rentang random amount untuk ORO pada Add LP (format: min,max, contoh: 0.5,1.0): `, `${dailyActivityConfig.addLpOroRange.min},${dailyActivityConfig.addLpOroRange.max}`, (err, value) => {
        promptBox.hide();
        safeRender();
        if (err || !value) {
          addLog(`Set Add LP ORO Range: Input dibatalkan.`, "system");
          manualConfigSubMenu.show();
          manualConfigSubMenu.focus();
          safeRender();
          return;
        }
        const [min, max] = value.split(",").map(v => parseFloat(v.trim()));
        if (isNaN(min) || isNaN(max) || min <= 0 || max <= min) {
          addLog(`Set Add LP ORO Range: Input tidak valid. Gunakan format min,max (contoh: 0.5,1.0) dengan min > 0 dan max > min.`, "error");
          manualConfigSubMenu.show();
          manualConfigSubMenu.focus();
          safeRender();
          return;
        }
        dailyActivityConfig.addLpOroRange = { min, max };
        saveConfig();
        addLog(`Set Add LP ORO Range: Rentang ORO untuk Add LP diubah menjadi ${min} - ${max}.`, "success");
        manualConfigSubMenu.show();
        manualConfigSubMenu.focus();
        safeRender();
      });
      break;
    case "Set Add LP Repetitions":
      promptBox.setFront();
      promptBox.input("Masukkan jumlah Add LP repetisi: ", dailyActivityConfig.addLpRepetitions.toString(), (err, value) => {
        promptBox.hide();
        safeRender();
        if (err || !value) {
          addLog("Set Add LP Repetitions: Input dibatalkan.", "error");
          manualConfigSubMenu.show();
          manualConfigSubMenu.focus();
          safeRender();
          return;
        }
        const addLpRepetitions = parseInt(value);
        if (isNaN(addLpRepetitions) || addLpRepetitions <= 0) {
          addLog("Set Add LP Repetitions: Input harus berupa angka positif.", "error");
          manualConfigSubMenu.show();
          manualConfigSubMenu.focus();
          safeRender();
          return;
        }
        dailyActivityConfig.addLpRepetitions = addLpRepetitions;
        saveConfig();
        addLog(`Add LP Repetitions set to ${addLpRepetitions}`, "success");
        updateStatus();
        manualConfigSubMenu.show();
        manualConfigSubMenu.focus();
        safeRender();
      });
      break;
    case "Back to Main Menu":
      manualConfigSubMenu.hide();
      mainMenu.show();
      mainMenu.focus();
      safeRender();
      break;
  }
});

manualConfigSubMenu.key(["escape"], () => {
  manualConfigSubMenu.hide();
  mainMenu.show();
  mainMenu.focus();
  safeRender();
});

screen.key(["escape", "q", "C-c"], () => {
  addLog("Exiting application", "info");
  clearInterval(statusInterval);
  process.exit(0);
});

async function initialize() {
  loadConfig();
  loadPrivateKeys();
  loadProxies();
  updateStatus();
  await updateWallets();
  updateLogs();
  safeRender();
  mainMenu.focus();
  addLog("OroSwap Bot initialized!", "system");
}

setTimeout(() => {
  adjustLayout();
  screen.on("resize", adjustLayout);
}, 100);

initialize();
