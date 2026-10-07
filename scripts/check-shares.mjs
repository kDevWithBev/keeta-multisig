/**
 * Offline check: two signature shares on one unsigned block verify and assemble.
 * No network.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const KeetaNet = require('@keetanetwork/keetanet-client');
const { Account, Block } = KeetaNet.lib;

const s1 = Account.fromSeed(Account.generateRandomSeed(), 0);
const s2 = Account.fromSeed(Account.generateRandomSeed(), 0);
const multisig = Account.fromPublicKeyString('keeta_a6uxgzd67kcrpjgzr2dzzwosigahtu4r5yamvilcazqktak454o47lmuv5ekw');
const vault = Account.fromPublicKeyString('keeta_arrcbs7pbidc3ojbsi5wk34dthzwtdlevjamsdzkpqoivxsvcb5kvxv5idjco');
const token = Account.fromPublicKeyString('keeta_anyiff4v34alvumupagmdyosydeq24lc4def5mrpmmyhx3j6vj2uucckeqn52');

const s1pub = Account.fromPublicKeyString(s1.publicKeyString.get());
const s2pub = Account.fromPublicKeyString(s2.publicKeyString.get());

const built = new Block.Builder({
  version: 2,
  purpose: Block.Purpose.GENERIC,
  account: vault,
  signer: [multisig, [s1pub, s2pub]],
  previous: Block.NO_PREVIOUS,
  network: 1413829460n,
  date: '2026-10-07T14:30:00.000Z',
  operations: [{
    type: Block.OperationType.SEND,
    to: s2pub,
    amount: 1n,
    token
  }]
});

const unsigned = await built.getUnsignedBlock();
const json = unsigned.toJSON();
if (json.signatures || json.signature) {
  throw new Error('unsigned JSON included a signature');
}
const again = await new Block.Builder(json).getUnsignedBlock();
if (again.hash.toString() !== unsigned.hash.toString()) {
  throw new Error('pasted unsigned block hash changed');
}

const ancillary = unsigned.toBytes(false);
const sig1 = await s1.sign(unsigned.hash.getBuffer(), { ancillaryData: ancillary });
const sig2 = await s2.sign(unsigned.hash.getBuffer(), { ancillaryData: ancillary });
if (s1pub.verify(unsigned.hash.getBuffer(), sig1.getBuffer()) !== true) {
  throw new Error('share 1 did not verify');
}
if (s2pub.verify(unsigned.hash.getBuffer(), sig2.getBuffer()) !== true) {
  throw new Error('share 2 did not verify');
}

const ordered = again.constructor.getSortedRequiredSigners(again.signer);
const bySigner = new Map([
  [s1pub.publicKeyString.get(), sig1.getBuffer()],
  [s2pub.publicKeyString.get(), sig2.getBuffer()]
]);
const signatures = ordered.map((signer) => {
  const found = bySigner.get(signer.publicKeyString.get());
  if (!found) throw new Error('missing share');
  return found;
});

const block = new Block({
  version: again.version,
  purpose: again.purpose,
  account: again.account,
  signer: again.signer,
  previous: again.previous,
  network: again.network,
  date: again.date,
  operations: again.operations,
  signatures
});
if (block.signatures.length !== 2) {
  throw new Error('assembled block does not have two signatures');
}
if (block.hash.toString() !== unsigned.hash.toString()) {
  throw new Error('assembled block hash changed');
}
console.log('shares-ok', block.hash.toString());
