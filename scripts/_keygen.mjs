// Generate two fresh BIP-39 testnet wallets and derive their EVM addresses
// using BOTH ethers and the WDK EVM lib hypha uses, asserting they match.
import * as bip39 from "bip39";
import { ethers } from "ethers";

const RPC = "https://testnet-rpc.plasma.to";

// WDK default export = WalletManagerEvm
const wdkMod = await import("@tetherto/wdk-wallet-evm");
const WalletManagerEvm = wdkMod.default ?? wdkMod;

async function derive(label, mnemonic) {
  // ethers derivation (m/44'/60'/0'/0/0 by default)
  const ev = ethers.HDNodeWallet.fromPhrase(mnemonic);
  let wdkAddr = "(wdk-failed)";
  try {
    const wm = new WalletManagerEvm(mnemonic, { provider: RPC });
    const acct = await wm.getAccount(0);
    wdkAddr = await acct.getAddress();
  } catch (e) {
    wdkAddr = `(wdk error: ${e?.message ?? e})`;
  }
  const match = wdkAddr.toLowerCase() === ev.address.toLowerCase();
  return { label, mnemonic, ethers: ev.address, wdk: wdkAddr, match };
}

const provider = await derive("PROVIDER (mini, payee/earns)", bip39.generateMnemonic(128));
const consumer = await derive("CONSUMER (Pro, payer/spends)", bip39.generateMnemonic(128));

for (const w of [provider, consumer]) {
  console.log(`\n#### ${w.label} ####`);
  console.log(`mnemonic: ${w.mnemonic}`);
  console.log(`address : ${w.ethers}`);
  console.log(`wdk addr: ${w.wdk}`);
  console.log(`MATCH   : ${w.match ? "✅ yes" : "❌ NO — do not use"}`);
}
console.log("\n=== JSON (for scripted env writing) ===");
console.log(JSON.stringify({
  provider: { mnemonic: provider.mnemonic, address: provider.ethers, match: provider.match },
  consumer: { mnemonic: consumer.mnemonic, address: consumer.ethers, match: consumer.match },
}));
