/**
 * Block rules for the 2-of-3 signer.
 * The caller passes the Keeta client and the network id.
 * This file does not keep key material.
 */
export const SALT_LABEL = 'github.com/surfingdegen/keeta-multisig/signer/v1';
export const FORBIDDEN_SALT_LABEL = 'keeta.com/wallet/seed/v1';
export const TEST_NETWORK_ID = 1413829460n;
export const MAIN_NETWORK_ID = 21378n;
export const TOKEN_DECIMALS = 18;

if (SALT_LABEL === FORBIDDEN_SALT_LABEL) {
  throw new Error('Refusing the wallet salt');
}

export function networkNameFromId(id) {
  const value = typeof id === 'bigint' ? id : BigInt(id);
  if (value === TEST_NETWORK_ID) return 'test';
  if (value === MAIN_NETWORK_ID) return 'main';
  throw new Error('The block is on an unknown network');
}

export function createProtocol(KeetaNet) {
  const { Account, Block } = KeetaNet.lib;

  function address(account) {
    if (typeof account === 'string') return account;
    return account.publicKeyString.get();
  }

  function canonical(text) {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error('An address is missing');
    }
    return Account.fromPublicKeyString(text.trim()).publicKeyString.get();
  }

  function parseDecimalAmount(input) {
    if (typeof input !== 'string') {
      throw new Error('Amount must be a decimal string');
    }
    const text = input.trim();
    if (!/^\d+(\.\d+)?$/.test(text)) {
      throw new Error('Amount must be a decimal string');
    }
    const [whole, frac = ''] = text.split('.');
    if (frac.length > TOKEN_DECIMALS) {
      throw new Error('Amount has more than 18 decimal places');
    }
    const raw = BigInt(whole + frac.padEnd(TOKEN_DECIMALS, '0'));
    if (raw <= 0n) {
      throw new Error('Amount must be greater than zero');
    }
    return raw;
  }

  function formatDecimalAmount(raw) {
    const negative = raw < 0n;
    const value = negative ? -raw : raw;
    const text = value.toString().padStart(TOKEN_DECIMALS + 1, '0');
    const whole = text.slice(0, -TOKEN_DECIMALS);
    const frac = text.slice(-TOKEN_DECIMALS).replace(/0+$/, '');
    return (negative ? '-' : '') + whole + (frac ? '.' + frac : '');
  }

  function hexFromBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    let hex = '';
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
    return hex;
  }

  function bufferFromHex(hex) {
    if (typeof hex !== 'string' || !/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
      throw new Error('A signature share is not hex');
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes.buffer;
  }

  function leavesOf(unsigned) {
    return unsigned.constructor.getSortedRequiredSigners(unsigned.signer).map(address);
  }

  function describe(unsigned) {
    const network = typeof unsigned.network === 'bigint' ? unsigned.network : BigInt(unsigned.network);
    if (unsigned.version !== 2) throw new Error('The block version is not 2');
    if (unsigned.purpose !== Block.Purpose.GENERIC) throw new Error('The block purpose is not a send');
    const networkName = networkNameFromId(network);
    if (!unsigned.operations || unsigned.operations.length !== 1) {
      throw new Error('The block must contain one SEND');
    }
    const op = unsigned.operations[0];
    if (op.type !== Block.OperationType.SEND) throw new Error('The block must contain one SEND');
    const leaves = leavesOf(unsigned);
    if (leaves.length !== 2) throw new Error('The block must list exactly two signers');
    const amount = typeof op.amount === 'bigint' ? op.amount : BigInt(op.amount);
    return {
      account: address(unsigned.account),
      multisig: address(unsigned.principal),
      to: address(op.to),
      token: address(op.token),
      amount,
      leaves,
      hash: unsigned.hash.toString(),
      network: networkName,
      date: unsigned.date instanceof Date ? unsigned.date.toISOString() : String(unsigned.date)
    };
  }

  async function openUnsigned(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new Error('The unsigned block is missing');
    }
    if (json.signatures || json.signature) {
      throw new Error('The unsigned block included a signature');
    }
    const first = await new Block.Builder(json).getUnsignedBlock();
    const second = await new Block.Builder(first.toJSON()).getUnsignedBlock();
    if (second.hash.toString() !== first.hash.toString()) {
      throw new Error('The unsigned block hash changed');
    }
    return second;
  }

  async function buildSend({ vault, multisig, signers, to, token, amount, previous, network }) {
    if (!Array.isArray(signers) || signers.length !== 2) {
      throw new Error('A send lists exactly two signers');
    }
    const first = canonical(signers[0]);
    const second = canonical(signers[1]);
    if (first === second) throw new Error('The two signers must be different');
    const built = new Block.Builder({
      version: 2,
      purpose: Block.Purpose.GENERIC,
      account: Account.fromPublicKeyString(canonical(vault)),
      signer: [
        Account.fromPublicKeyString(canonical(multisig)),
        [Account.fromPublicKeyString(first), Account.fromPublicKeyString(second)]
      ],
      previous: previous || Block.NO_PREVIOUS,
      network,
      date: new Date().toISOString(),
      operations: [{
        type: Block.OperationType.SEND,
        to: Account.fromPublicKeyString(canonical(to)),
        amount,
        token: Account.fromPublicKeyString(canonical(token))
      }]
    });
    const unsigned = await built.getUnsignedBlock();
    const json = unsigned.toJSON();
    const opened = await openUnsigned(json);
    if (opened.hash.toString() !== unsigned.hash.toString()) {
      throw new Error('The unsigned block hash changed');
    }
    return { json, described: describe(opened) };
  }

  function assertProfile(described, profile) {
    if (profile.network && described.network !== profile.network) {
      throw new Error('The block is on a different network than this profile');
    }
    if (described.account !== profile.vault) {
      throw new Error("The block account is not this profile's vault");
    }
    if (described.multisig !== profile.multisig) {
      throw new Error("The signer is not this profile's multisig");
    }
    if (!described.leaves.includes(profile.publicKey)) {
      throw new Error("This profile's key is not one of the two signers");
    }
    const other = described.leaves.find((leaf) => leaf !== profile.publicKey);
    if (other !== profile.coSigner) {
      throw new Error('The other signer on this block is not the public key saved in this profile');
    }
  }

  function verifyShare(unsigned, share) {
    if (!share || typeof share.signer !== 'string' || typeof share.signature !== 'string') {
      throw new Error('A signature share is missing');
    }
    const signer = canonical(share.signer);
    const buffer = bufferFromHex(share.signature);
    const ok = Account.fromPublicKeyString(signer).verify(unsigned.hash.getBuffer(), buffer);
    if (ok !== true) throw new Error('A signature share did not verify');
    return { signer, buffer };
  }

  async function shareFrom(unsigned, account) {
    const signature = await account.sign(unsigned.hash.getBuffer(), {
      ancillaryData: unsigned.toBytes(false)
    });
    const buffer = signature.getBuffer();
    const signer = address(account);
    const ok = Account.fromPublicKeyString(signer).verify(unsigned.hash.getBuffer(), buffer);
    if (ok !== true) throw new Error("This profile's signature share did not verify");
    return { signer, signature: hexFromBuffer(buffer) };
  }

  function assemble(unsigned, shares) {
    const leaves = leavesOf(unsigned);
    if (leaves.length !== 2) throw new Error('Refusing to publish without exactly two signers');
    if (!Array.isArray(shares) || shares.length !== 2) {
      throw new Error('Refusing to publish without exactly two signature shares');
    }
    const bySigner = new Map();
    for (const share of shares) {
      const verified = verifyShare(unsigned, share);
      if (bySigner.has(verified.signer)) throw new Error('A signer produced more than one share');
      bySigner.set(verified.signer, verified.buffer);
    }
    for (const signer of bySigner.keys()) {
      if (!leaves.includes(signer)) throw new Error('A share is not for a signer on this block');
    }
    const signatures = leaves.map((signer) => {
      const found = bySigner.get(signer);
      if (!found) throw new Error('A required signer has no share');
      return found;
    });
    const block = new Block({
      version: unsigned.version,
      purpose: unsigned.purpose,
      account: unsigned.account,
      signer: unsigned.signer,
      previous: unsigned.previous,
      network: unsigned.network,
      date: unsigned.date,
      operations: unsigned.operations,
      signatures
    });
    if (!block.signatures || block.signatures.length !== 2) {
      throw new Error('Assembled block does not have two signatures');
    }
    if (block.hash.toString() !== unsigned.hash.toString()) {
      throw new Error('Assembled block hash changed');
    }
    return block;
  }

  function describeFees(quotes, baseTokenAddress) {
    const totals = new Map();
    for (const quote of quotes || []) {
      const fee = quote && quote.fee;
      const fees = fee == null ? [] : (Array.isArray(fee) ? fee : [fee]);
      for (const item of fees) {
        if (item == null || item.amount == null) continue;
        const amount = typeof item.amount === 'bigint' ? item.amount : BigInt(item.amount);
        if (amount === 0n) continue;
        const token = item.token ? address(item.token) : baseTokenAddress;
        totals.set(token, (totals.get(token) || 0n) + amount);
      }
    }
    return [...totals.entries()].map(([token, amount]) => ({ token, amount }));
  }

  function payloadFrom(json, shares, statedOrigin) {
    return {
      v: 1,
      network: networkNameFromId(json.network),
      statedOrigin: statedOrigin || null,
      unsigned: json,
      shares
    };
  }

  function readPayload(value) {
    let payload = value;
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) throw new Error('Paste the payload');
      payload = JSON.parse(text);
    }
    if (!payload || payload.v !== 1 || (payload.network !== 'test' && payload.network !== 'main') || !payload.unsigned) {
      throw new Error('This is not a payload from this extension');
    }
    if (networkNameFromId(payload.unsigned.network) !== payload.network) {
      throw new Error('The payload network does not match the block');
    }
    if (!Array.isArray(payload.shares)) throw new Error('The payload has no share list');
    if (payload.unsigned.signatures || payload.unsigned.signature) {
      throw new Error('The unsigned block included a signature');
    }
    return payload;
  }

  return {
    address,
    canonical,
    parseDecimalAmount,
    formatDecimalAmount,
    describe,
    openUnsigned,
    buildSend,
    assertProfile,
    verifyShare,
    shareFrom,
    assemble,
    describeFees,
    payloadFrom,
    readPayload
  };
}
