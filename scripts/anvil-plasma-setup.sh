#!/usr/bin/env bash
# Idempotent setup of the LOCAL anvil fork of Plasma testnet (chain 9746) for the
# self-hosted x402 facilitator demo. Safe to re-run any time (e.g. after anvil restart).
#
# Does:
#   1. fund gas (XPL) for provider, consumer, USDT0-owner via anvil_setBalance
#   2. etch the x402 upto Permit2 proxy (0x4020...) from cached bytecode (not on Plasma testnet)
#   3. mint USDT0 to the consumer (impersonate owner/minter) if balance is low
#   4. consumer approves Permit2 to MAX once (avoids per-settle re-approve + USDT-style quirk)
#   5. sync anvil clock to real time (fork block is ~10min stale → would trip PaymentTooEarly)
#
# Money-safety: pure localhost. Never touches the real chain.
set -euo pipefail
A="${ANVIL_RPC:-http://127.0.0.1:8545}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ENVF="$HERE/../data/.economy.probe.env"

# read addresses + consumer mnemonic from the gitignored probe env
get() { grep -E "^$1=" "$ENVF" | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//'; }
PROV=$(get PROVIDER_ADDRESS)
CONS=$(get CONSUMER_ADDRESS)
CONS_MN=$(get CONSUMER_MNEMONIC)
USDT0=0x502012b361AebCE43b26Ec812B74D9a51dB4D412
OWNER=0xf47d4D28f8645C077c7C2965A99145aa3E80AaDc
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
PROXY=0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002
MAXU=0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
WEI100=0x56BC75E2D63100000

echo "chain $(cast chain-id --rpc-url $A) @ block $(cast block-number --rpc-url $A)"

echo "1) fund gas"
for a in $PROV $CONS $OWNER; do cast rpc anvil_setBalance "$a" $WEI100 --rpc-url $A >/dev/null; done

echo "2) etch upto proxy"
if [ "$(cast code $PROXY --rpc-url $A)" = "0x" ]; then
  cast rpc anvil_setCode $PROXY "$(cat "$HERE/x402-upto-proxy.bytecode")" --rpc-url $A >/dev/null
  echo "   etched ($(($(cast code $PROXY --rpc-url $A | wc -c)/2)) bytes)"
else echo "   already present"; fi

echo "3) mint USDT0 to consumer (if < 100)"
BAL=$(cast call $USDT0 "balanceOf(address)(uint256)" $CONS --rpc-url $A | awk '{print $1}')
if [ "$(python3 -c "print(1 if int('$BAL')<100000000 else 0)")" = "1" ]; then
  cast rpc anvil_impersonateAccount $OWNER --rpc-url $A >/dev/null
  cast send $USDT0 "mint(address,uint256)" $CONS 1000000000 --from $OWNER --unlocked --rpc-url $A >/dev/null
  cast rpc anvil_stopImpersonatingAccount $OWNER --rpc-url $A >/dev/null
  echo "   minted 1000 USDT0"
else echo "   consumer already holds $(python3 -c "print(int('$BAL')/1e6)") USDT0"; fi

echo "4) consumer approves Permit2 (MAX, once)"
ALLOW=$(cast call $USDT0 "allowance(address,address)(uint256)" $CONS $PERMIT2 --rpc-url $A | awk '{print $1}')
if [ "$(python3 -c "print(1 if int('$ALLOW')<10**30 else 0)")" = "1" ]; then
  cast send $USDT0 "approve(address,uint256)" $PERMIT2 $MAXU --mnemonic "$CONS_MN" --rpc-url $A >/dev/null
  echo "   approved MAX"
else echo "   already approved ($(python3 -c "print(int('$ALLOW'))"))"; fi

echo "5) sync clock to real now"
cast rpc anvil_setTime "$(python3 -c 'import time;print(int(time.time()))')" --rpc-url $A >/dev/null
cast rpc anvil_mine --rpc-url $A >/dev/null
echo "   block.timestamp = $(cast block latest --rpc-url $A --field timestamp) (real now $(python3 -c 'import time;print(int(time.time()))'))"

echo "✅ anvil Plasma fork ready"
echo "   provider $PROV  XPL=$(python3 -c "print(int('$(cast balance $PROV --rpc-url $A)')/1e18)")  USDT0=$(python3 -c "print(int('$(cast call $USDT0 'balanceOf(address)(uint256)' $PROV --rpc-url $A | awk '{print $1}')')/1e6)")"
echo "   consumer $CONS  XPL=$(python3 -c "print(int('$(cast balance $CONS --rpc-url $A)')/1e18)")  USDT0=$(python3 -c "print(int('$(cast call $USDT0 'balanceOf(address)(uint256)' $CONS --rpc-url $A | awk '{print $1}')')/1e6)")"
