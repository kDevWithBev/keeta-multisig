/**
 * Offline checks for one share versus two shares. No network.
 */
import { createRequire } from 'node:module';
import { createProtocol, FORBIDDEN_SALT_LABEL, SALT_LABEL } from '../src/protocol.mjs';

const require = createRequire(import.meta.url);
const KeetaNet = require('@keetanetwork/keetanet-client');
const { Account, Block } = KeetaNet.lib;
const protocol = createProtocol(KeetaNet);

if (SALT_LABEL === FORBIDDEN_SALT_LABEL || SALT_LABEL.includes('keeta.com/wallet')) {
  throw new Error('salt label is the wallet salt');
}

function address(account) {
  return account.publicKeyString.get();
}

const s1 = Account.fromSeed(Account.generateRandomSeed(), 0);
const s2 = Account.fromSeed(Account.generateRandomSeed(), 0);
const s3 = Account.fromSeed(Account.generateRandomSeed(), 0);
const vault = Account.fromPublicKeyString('keeta_aqopmqwxgq75o2cdkvpprnipp6q4xzuwqmcia3po6iwhxr6jf7bfkziliyf4m');
const multisig = Account.fromPublicKeyString('keeta_a4dmetpi4hoyou2uxrrfi6jqrql6byjqeaopr63yab6eq6czpqiohmzhvchca');
const token = Account.fromPublicKeyString('keeta_anyiff4v34alvumupagmdyosydeq24lc4def5mrpmmyhx3j6vj2uucckeqn52');
const profile = {
  publicKey: address(s1),
  coSigner: address(s2),
  vault: address(vault),
  multisig: address(multisig)
};

const built = await protocol.buildSend({
  vault: profile.vault,
  multisig: profile.multisig,
  signers: [profile.publicKey, profile.coSigner],
  to: address(s3),
  token: address(token),
  amount: protocol.parseDecimalAmount('0.01'),
  previous: Block.NO_PREVIOUS,
  network: 1413829460n
});

if (protocol.formatDecimalAmount(built.described.amount) !== '0.01') {
  throw new Error('amount format changed');
}

const unsigned = await protocol.openUnsigned(built.json);
protocol.assertProfile(built.described, profile);

const one = [await protocol.shareFrom(unsigned, s1)];
let refused = false;
try {
  protocol.assemble(unsigned, one);
} catch (err) {
  refused = /exactly two signature shares/.test(err.message);
}
if (!refused) throw new Error('one share was not refused');

const two = one.concat([await protocol.shareFrom(unsigned, s2)]);
const block = protocol.assemble(unsigned, two);
if (block.signatures.length !== 2) throw new Error('two shares did not assemble');
if (block.hash.toString() !== built.described.hash) throw new Error('hash changed after two shares');

const wrongProfile = { ...profile, vault: address(s3) };
let wrongVault = false;
try {
  protocol.assertProfile(built.described, wrongProfile);
} catch (err) {
  wrongVault = /not this profile's vault/.test(err.message);
}
if (!wrongVault) throw new Error('a different account was accepted');

let oneSigner = false;
try {
  await protocol.buildSend({
    vault: profile.vault,
    multisig: profile.multisig,
    signers: [profile.publicKey],
    to: address(s3),
    token: address(token),
    amount: 1n,
    previous: built.json.previous,
    network: 1413829460n
  });
} catch (err) {
  oneSigner = /exactly two signers/.test(err.message);
}
if (!oneSigner) throw new Error('a one-signer send was built');

const payload = protocol.payloadFrom(built.json, one, 'https://example.test');
const read = protocol.readPayload(JSON.stringify(payload));
if (read.statedOrigin !== 'https://example.test' || read.shares.length !== 1) {
  throw new Error('payload round-trip changed');
}

const phrase = require('bip39').generateMnemonic(256);
if (phrase.split(' ').length !== 24) throw new Error('paper key is not 24 words');
const paperSeed = await Account.seedFromPassphrase(phrase);
const paper = Account.fromSeed(paperSeed, 0);
if (!paper.publicKeyString.get().startsWith('keeta_')) throw new Error('paper key did not derive');

console.log('payload-ok', block.hash.toString());
