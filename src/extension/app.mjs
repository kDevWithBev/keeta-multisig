import KeetaNet from '@keetanetwork/keetanet-client/client/index-browser.js';
import { KeetaPasskeyPRFKeyPairFactory } from '@keetanetwork/keetanet-client/lib/utils/external-keys/passkey-prf.js';
import { entropyToMnemonic, generateMnemonic, validateMnemonic } from 'bip39';
import { FORBIDDEN_SALT_LABEL, SALT_LABEL, createProtocol } from '../protocol.mjs';

const { Account, Block, Permissions } = KeetaNet.lib;
const { UserClient } = KeetaNet;
const protocol = createProtocol(KeetaNet);
const PASSWORD_NOTE = 'Passkey is not available here. This profile keeps a password-encrypted key in extension storage.';
const STORAGE_KEY = 'profile';
const ITERATIONS = 210000;

const view = {
  screen: 'loading',
  profile: null,
  request: null,
  answered: false,
  error: null,
  notice: null,
  busy: false,
  passkeyFailed: false,
  phrase: null,
  recoveryPublic: null,
  draft: null,
  result: null,
  log: '',
  balances: null,
  salt: null,
  preparing: false
};

function h(tag, attrs, kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, String(value));
  }
  for (const kid of kids || []) {
    if (kid == null) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function button(label, className, onclick) {
  const node = h('button', { class: className, type: 'button' }, [label]);
  node.disabled = view.busy;
  node.addEventListener('click', onclick);
  return node;
}

function banner() {
  return h('div', { class: 'banner' }, ['Test network only. One signer key in this profile.']);
}

function passwordNote() {
  if (!view.passkeyFailed && (!view.profile || view.profile.method !== 'password')) return null;
  const note = h('div', { class: 'note' }, [PASSWORD_NOTE]);
  return note;
}

function field(label, node) {
  const wrap = h('label', {}, [label]);
  wrap.append(node);
  return wrap;
}

function textInput(id, value) {
  const input = h('input', { id, type: 'text', autocomplete: 'off', spellcheck: 'false' });
  if (value) input.value = value;
  return input;
}

function kv(rows) {
  const wrap = h('div', { class: 'kv' });
  for (const [label, value, id] of rows) {
    const row = h('div');
    const strong = h('b', id ? { id } : {}, [value == null || value === '' ? '—' : String(value)]);
    row.append(h('span', {}, [label]), strong);
    wrap.append(row);
  }
  return wrap;
}

function logLine(text) {
  view.log = view.log ? view.log + '\n' + text : text;
  const node = document.getElementById('log');
  if (node) node.textContent = view.log;
}

function takePassword() {
  const input = document.getElementById('password');
  const password = input ? input.value : '';
  if (input) input.value = '';
  return password;
}

function requestId() {
  const match = /^#request=([^&]+)/.exec(location.hash || '');
  return match ? decodeURIComponent(match[1]) : null;
}

function ready(profile) {
  return Boolean(profile && profile.publicKey && profile.multisig && profile.vault && profile.vaultOwned && profile.coSigner);
}

function bytesToB64(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function b64ToBytes(text) {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function signerSalt() {
  if (SALT_LABEL === FORBIDDEN_SALT_LABEL) throw new Error('Refusing the wallet salt');
  const encoder = new TextEncoder();
  const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(SALT_LABEL)));
  const forbidden = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(FORBIDDEN_SALT_LABEL)));
  if (salt.length === forbidden.length && salt.every((byte, index) => byte === forbidden[index])) {
    throw new Error('Refusing the wallet salt');
  }
  return salt;
}

function passkeyFactory() {
  return KeetaPasskeyPRFKeyPairFactory({
    KeetaNet: {
      lib: {
        Account,
        Utils: {
          Helper: KeetaNet.lib.Utils.Helper,
          Buffer: KeetaNet.lib.Utils.Buffer
        }
      }
    },
    navigator,
    bip39: { entropyToMnemonic }
  });
}

async function loadProfile() {
  const got = await chrome.storage.local.get(STORAGE_KEY);
  return got[STORAGE_KEY] || null;
}

async function saveProfile(profile) {
  const stored = {
    v: 1,
    method: profile.method,
    publicKey: profile.publicKey,
    passkeyKeyId: profile.passkeyKeyId || null,
    cipher: profile.cipher || null,
    multisig: profile.multisig || null,
    vault: profile.vault || null,
    vaultOwned: profile.vaultOwned === true,
    coSigner: profile.coSigner || null,
    recoveryPublicKey: profile.recoveryPublicKey || null
  };
  if (stored.method !== 'passkey' && stored.method !== 'password') {
    throw new Error('Unknown signer method');
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: stored });
  view.profile = stored;
  return stored;
}

async function encryptSeed(seedBytes, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, seedBytes));
  return {
    saltB64: bytesToB64(salt),
    ivB64: bytesToB64(iv),
    cipherB64: bytesToB64(cipher),
    iterations: ITERATIONS
  };
}

async function decryptSeed(record, password) {
  if (!record || record.iterations !== ITERATIONS) {
    throw new Error('This profile has no password-encrypted key');
  }
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBytes(record.saltB64), iterations: record.iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(record.ivB64) },
      key,
      b64ToBytes(record.cipherB64)
    ));
  } catch {
    throw new Error("The password did not unlock this profile's key");
  }
}

function dropAccount(account) {
  if (account && typeof account.removeCachedAccountTimeout === 'function') {
    account.removeCachedAccountTimeout();
  }
}

async function unlock(profile, password) {
  if (profile.method === 'passkey') {
    const factory = passkeyFactory();
    const account = await factory.lookup({
      salt: view.salt,
      keyID: profile.passkeyKeyId,
      rpID: chrome.runtime.id
    });
    if (account.publicKeyString.get() !== profile.publicKey) {
      dropAccount(account);
      throw new Error('The passkey is a different key than this profile');
    }
    return account;
  }
  if (!password) throw new Error('Enter the password for this profile');
  const seed = await decryptSeed(profile.cipher, password);
  try {
    const account = Account.fromSeed(seed.slice().buffer, 0);
    if (account.publicKeyString.get() !== profile.publicKey) {
      throw new Error("The password did not unlock this profile's key");
    }
    return account;
  } finally {
    seed.fill(0);
  }
}

async function withRead(fn) {
  const client = UserClient.fromNetwork('test', null);
  try {
    return await fn(client);
  } finally {
    await client.destroy();
  }
}

async function withUnlocked(password, fn) {
  let account = null;
  let client = null;
  try {
    account = await unlock(view.profile, password);
    client = UserClient.fromNetwork('test', account);
    return await fn(client, account);
  } finally {
    if (client) {
      try { await client.destroy(); } catch { /* already failing */ }
    }
    dropAccount(account);
    account = null;
    client = null;
  }
}

async function faucet(address) {
  const response = await fetch('https://faucet.test.keeta.com/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `address=${encodeURIComponent(address)}&amount=10`
  });
  const text = await response.text();
  const visible = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const message = (visible.match(/An error occurred:[^.]+/) || [])[0] || null;
  return { httpStatus: response.status, message };
}

async function waitForBalance(client, account) {
  const started = Date.now();
  let latest = 0n;
  while (Date.now() - started < 120000) {
    latest = await client.client.getBalance(account, client.baseToken);
    if (latest > 0n) return latest;
    logLine('Waiting for a test faucet balance.');
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error('The test faucet balance was not visible. Last balance was 0.');
}

async function multisigOwns(client, vault, multisig) {
  const rows = await client.client.listACLsByEntity(vault);
  return rows.some((row) => {
    if (!row.principal || !row.principal.publicKeyString) return false;
    if (row.principal.publicKeyString.get() !== multisig) return false;
    return Boolean(row.permissions && row.permissions.has(['OWNER']));
  });
}

async function quoteFees(client, json) {
  try {
    const unsigned = await protocol.openUnsigned(json);
    const quotes = await client.getQuotes([unsigned]);
    return {
      fees: protocol.describeFees(quotes, protocol.address(client.baseToken)),
      error: null,
      baseToken: protocol.address(client.baseToken)
    };
  } catch (err) {
    return {
      fees: [],
      error: err && err.message ? err.message : 'The network did not return a fee quote',
      baseToken: protocol.address(client.baseToken)
    };
  }
}

function feeText(fees, baseToken) {
  if (!fees || fees.length === 0) return 'The network did not return a fee.';
  return fees.map((fee) => {
    const shown = fee.token === baseToken
      ? protocol.formatDecimalAmount(fee.amount) + ' KTA'
      : fee.amount.toString() + ' raw units';
    return shown + ' (' + fee.token + ')';
  }).join('; ');
}

function respond(result, error) {
  if (!view.request || view.answered) return;
  view.answered = true;
  const id = view.request.id;
  const record = { result: result == null ? null : result, error: error || null };
  chrome.storage.session.set({ ['res:' + id]: record });
  try {
    chrome.runtime.sendMessage({
      source: 'keeta-multisig-ui',
      id,
      result: record.result,
      error: record.error
    });
  } catch {
    /* The page also watches session storage. */
  }
}

function chooseScreen() {
  const profile = view.profile;
  if (!profile) return 'start';
  if (view.phrase) return 'paper';
  if (ready(profile) && view.request && !view.answered && view.request.method === 'connect') return 'connect';
  if (ready(profile) && view.request && !view.answered && view.request.method === 'send') return 'send-loading';
  if (ready(profile)) return 'home';
  if (profile.recoveryPublicKey && !profile.vaultOwned) return 'create-network';
  return 'role';
}

async function createPasskey() {
  const factory = passkeyFactory();
  let account = await factory.generate({
    salt: view.salt,
    rp: { id: chrome.runtime.id, name: 'Keeta multisig signer' },
    user: { name: 'signer', displayName: 'Keeta multisig signer' }
  });
  try {
    const publicKey = account.publicKeyString.get();
    const passkeyKeyId = account.keyID;
    if (!publicKey || !passkeyKeyId) throw new Error('The passkey did not return a key');
    await saveProfile({
      method: 'passkey',
      publicKey,
      passkeyKeyId,
      cipher: null,
      multisig: null,
      vault: null,
      vaultOwned: false,
      coSigner: null,
      recoveryPublicKey: null
    });
  } finally {
    dropAccount(account);
    account = null;
  }
}

async function createPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Use a password of at least 8 characters');
  }
  const seed = new Uint8Array(Account.generateRandomSeed());
  try {
    const cipher = await encryptSeed(seed, password);
    const account = Account.fromSeed(seed.slice().buffer, 0);
    await saveProfile({
      method: 'password',
      publicKey: account.publicKeyString.get(),
      passkeyKeyId: null,
      cipher,
      multisig: null,
      vault: null,
      vaultOwned: false,
      coSigner: null,
      recoveryPublicKey: null
    });
  } finally {
    seed.fill(0);
  }
}

async function restorePaper(phrase, password, confirmed) {
  if (!confirmed) throw new Error('Confirm this is the paper key this extension showed');
  const words = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  if (!validateMnemonic(words)) throw new Error('Those words are not the 24-word paper key');
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Use a password of at least 8 characters');
  }
  const seed = new Uint8Array(await Account.seedFromPassphrase(words));
  try {
    const cipher = await encryptSeed(seed, password);
    const account = Account.fromSeed(seed.slice().buffer, 0);
    await saveProfile({
      method: 'password',
      publicKey: account.publicKeyString.get(),
      passkeyKeyId: null,
      cipher,
      multisig: null,
      vault: null,
      vaultOwned: false,
      coSigner: null,
      recoveryPublicKey: null
    });
  } finally {
    seed.fill(0);
  }
}

async function makePaper() {
  const phrase = generateMnemonic(256);
  const seed = new Uint8Array(await Account.seedFromPassphrase(phrase));
  try {
    const account = Account.fromSeed(seed.slice().buffer, 0);
    view.recoveryPublic = account.publicKeyString.get();
    view.phrase = phrase;
  } finally {
    seed.fill(0);
  }
}

async function publishSetup(password, coSignerText) {
  const coSigner = protocol.canonical(coSignerText);
  const other = Account.fromPublicKeyString(coSigner);
  if (!other.isAccount()) throw new Error('The other signer must be a keyed account');
  if (coSigner === view.profile.publicKey) throw new Error('The other signer is this profile');
  if (!view.profile.recoveryPublicKey) throw new Error('The paper key public key is missing');
  let current = await saveProfile({ ...view.profile, coSigner });
  await withUnlocked(password, async (client, account) => {
    const selfBalance = await client.client.getBalance(account, client.baseToken);
    if (selfBalance === 0n) {
      logLine('Requesting test KTA for this profile, for fees.');
      const funded = await faucet(protocol.address(account));
      if (funded.httpStatus !== 200) {
        throw new Error(funded.message || 'The test faucet refused this profile');
      }
      await waitForBalance(client, account);
    }
    if (!current.multisig) {
      logLine('Publishing the 2-of-3 identifier.');
      const builder = client.initBuilder();
      const pending = builder.generateIdentifier({
        type: Account.AccountKeyAlgorithm.MULTISIG,
        signers: [
          account,
          Account.fromPublicKeyString(coSigner),
          Account.fromPublicKeyString(current.recoveryPublicKey)
        ],
        quorum: 2n
      });
      await builder.computeBlocks();
      const published = await builder.publish();
      if (!published || published.publish !== true) throw new Error('The network did not publish the identifier');
      const multisig = protocol.address(pending.account);
      const info = await client.client.getAccountInfo(multisig);
      const quorum = info && info.info ? info.info.multisigQuorum : null;
      if (quorum == null || BigInt(quorum) !== 2n) throw new Error('The identifier quorum was not 2');
      current = await saveProfile({ ...current, multisig });
      logLine('Identifier ' + multisig);
    }
    if (!current.vault) {
      logLine('Publishing the storage account.');
      const builder = client.initBuilder();
      const pending = builder.generateIdentifier(Account.AccountKeyAlgorithm.STORAGE);
      await builder.computeBlocks();
      const published = await builder.publish();
      if (!published || published.publish !== true) throw new Error('The network did not publish the storage account');
      logLine('Allowing the storage account to hold the base token.');
      const perms = client.initBuilder();
      perms.updatePermissions(
        client.baseToken,
        new Permissions(['STORAGE_CAN_HOLD']),
        undefined,
        Block.AdjustMethod.SET,
        { account: pending.account }
      );
      perms.setInfo({
        name: '',
        description: '',
        metadata: '',
        defaultPermission: new Permissions(['STORAGE_DEPOSIT'])
      }, { account: pending.account });
      const permPublished = await perms.publish();
      if (!permPublished || permPublished.publish !== true) {
        throw new Error('Storage permissions were not published');
      }
      const vault = protocol.address(pending.account);
      current = await saveProfile({ ...current, vault, vaultOwned: false });
      logLine('Storage account ' + vault);
    }
    if (!current.vaultOwned) {
      const balance = await client.client.getBalance(current.vault, client.baseToken);
      if (balance === 0n) {
        logLine('Requesting test KTA for the storage account.');
        const funded = await faucet(current.vault);
        if (funded.httpStatus !== 200) {
          throw new Error(funded.message || 'The test faucet refused the storage account');
        }
        await waitForBalance(client, current.vault);
      }
      if (!(await multisigOwns(client, current.vault, current.multisig))) {
        logLine('Making the multisig the only owner.');
        const vaultAccount = Account.fromPublicKeyString(current.vault);
        const own = client.initBuilder();
        own.updatePermissions(
          Account.fromPublicKeyString(current.multisig),
          new Permissions(['OWNER']),
          undefined,
          Block.AdjustMethod.SET,
          { account: vaultAccount }
        );
        own.updatePermissions(account, false, undefined, Block.AdjustMethod.SET, { account: vaultAccount });
        const owned = await own.publish();
        if (!owned || owned.publish !== true) throw new Error('Ownership was not published');
      }
      if (!(await multisigOwns(client, current.vault, current.multisig))) {
        throw new Error('The multisig is not the owner of the storage account');
      }
      current = await saveProfile({ ...current, vaultOwned: true });
      logLine('Ownership published.');
    }
  });
}

async function joinExisting(multisigText, vaultText, coSignerText) {
  const multisig = protocol.canonical(multisigText);
  const vault = protocol.canonical(vaultText);
  const coSigner = protocol.canonical(coSignerText);
  if (!Account.fromPublicKeyString(multisig).isMultisig()) throw new Error('That address is not a multisig');
  if (!Account.fromPublicKeyString(vault).isStorage()) throw new Error('That address is not a storage account');
  if (!Account.fromPublicKeyString(coSigner).isAccount()) throw new Error('The other signer must be a keyed account');
  if (coSigner === view.profile.publicKey) throw new Error('The other signer is this profile');
  await withRead(async (client) => {
    const info = await client.client.getAccountInfo(multisig);
    const quorum = info && info.info ? info.info.multisigQuorum : null;
    if (quorum == null || BigInt(quorum) !== 2n) throw new Error('That multisig quorum is not 2');
    if (!(await multisigOwns(client, vault, multisig))) {
      throw new Error('That storage account is not owned by that multisig');
    }
  });
  await saveProfile({ ...view.profile, multisig, vault, vaultOwned: true, coSigner });
}

async function prepareSiteSend() {
  const params = view.request.params || {};
  const amount = protocol.parseDecimalAmount(typeof params.amount === 'string' ? params.amount : '');
  const to = protocol.canonical(params.to);
  let token = params.token ? protocol.canonical(String(params.token)) : null;
  const prepared = await withRead(async (client) => {
    if (!token) token = protocol.address(client.baseToken);
    const head = await client.client.getHeadBlock(view.profile.vault);
    const send = await protocol.buildSend({
      vault: view.profile.vault,
      multisig: view.profile.multisig,
      signers: [view.profile.publicKey, view.profile.coSigner],
      to,
      token,
      amount,
      previous: head ? head.hash : Block.NO_PREVIOUS,
      network: client.network
    });
    protocol.assertProfile(send.described, view.profile);
    if (send.described.to !== to || send.described.amount !== amount || send.described.token !== token) {
      throw new Error('The block does not match the request');
    }
    const quoted = await quoteFees(client, send.json);
    return { send, quoted };
  });
  view.draft = {
    mode: 'site',
    origin: view.request.origin || 'unknown',
    json: prepared.send.json,
    described: prepared.send.described,
    fees: prepared.quoted.fees,
    feeError: prepared.quoted.error,
    baseToken: prepared.quoted.baseToken,
    shares: []
  };
}

async function preparePaste(text) {
  const payload = protocol.readPayload(text);
  await withRead(async (client) => {
    const unsigned = await protocol.openUnsigned(payload.unsigned);
    const described = protocol.describe(unsigned);
    protocol.assertProfile(described, view.profile);
    const shares = [];
    const seen = new Set();
    for (const share of payload.shares) {
      const verified = protocol.verifyShare(unsigned, share);
      if (seen.has(verified.signer)) throw new Error('A signer produced more than one share');
      if (!described.leaves.includes(verified.signer)) throw new Error('A share is not for a signer on this block');
      seen.add(verified.signer);
      shares.push({ signer: verified.signer, signature: share.signature.toLowerCase() });
    }
    const quoted = await quoteFees(client, payload.unsigned);
    view.draft = {
      mode: 'paste',
      origin: payload.statedOrigin,
      json: payload.unsigned,
      described,
      fees: quoted.fees,
      feeError: quoted.error,
      baseToken: quoted.baseToken,
      shares
    };
  });
}

function approveLabel() {
  const haveMine = view.draft.shares.some((share) => share.signer === view.profile.publicKey);
  if (view.draft.mode === 'site' || (view.draft.shares.length === 0 && !haveMine)) return 'Approve and sign one share';
  if (!haveMine && view.draft.shares.length === 1) return 'Approve, add this share, and publish';
  if (view.draft.shares.length >= 2) return 'Approve and publish';
  return 'Approve and sign one share';
}

async function approve() {
  const password = takePassword();
  const draft = view.draft;
  view.busy = true;
  view.error = null;
  render();
  try {
    const outcome = await withUnlocked(password, async (client, account) => {
      const unsigned = await protocol.openUnsigned(draft.json);
      const described = protocol.describe(unsigned);
      protocol.assertProfile(described, view.profile);
      if (
        described.hash !== draft.described.hash ||
        described.to !== draft.described.to ||
        described.amount !== draft.described.amount ||
        described.token !== draft.described.token ||
        described.account !== draft.described.account
      ) {
        throw new Error('The block changed before approval');
      }
      const shares = draft.shares.map((share) => ({ signer: share.signer, signature: share.signature }));
      const mine = protocol.address(account);
      if (!shares.some((share) => share.signer === mine)) {
        shares.push(await protocol.shareFrom(unsigned, account));
      }
      const payload = protocol.payloadFrom(draft.json, shares, draft.origin);
      if (draft.mode === 'site') {
        if (shares.length !== 1) throw new Error('The site request must leave with one share');
        return { published: false, payload };
      }
      if (shares.length !== 2) return { published: false, payload };
      const block = protocol.assemble(unsigned, shares);
      const transmitted = await client.transmit([block]);
      if (!transmitted || transmitted.publish !== true) throw new Error('The network did not publish the block');
      return { published: true, payload, blockHash: block.hash.toString() };
    });
    view.result = outcome;
    view.draft = null;
    if (view.request && view.request.method === 'send') {
      respond(outcome.published
        ? { published: true, block: outcome.blockHash, payload: outcome.payload }
        : outcome.payload, null);
    }
    view.screen = 'result';
  } catch (err) {
    view.error = err && err.message ? err.message : String(err);
  } finally {
    view.busy = false;
    render();
  }
}

function waitingNote() {
  if (!view.request || view.answered) return null;
  const origin = view.request.origin || 'unknown';
  return h('div', { class: 'note' }, [
    'A page at ' + origin + ' is waiting. Nothing is signed yet.'
  ]);
}

function refuseButton() {
  if (!view.request || view.answered) return null;
  return button('Refuse', 'ghost', () => {
    respond(null, 'The request was not approved.');
    view.notice = 'The request was not approved.';
    view.request = null;
    history.replaceState(null, '', location.pathname);
    view.screen = chooseScreen();
    render();
  });
}

function copyButton(text) {
  return button('Copy', 'ghost', async () => {
    try { await navigator.clipboard.writeText(text); } catch { /* the text stays on screen */ }
  });
}

function renderStart() {
  return h('div', {}, [
    h('p', {}, ['This profile does not have a signer yet. It will keep one key and no other.']),
    h('div', { class: 'row' }, [
      button('Create this profile\'s signer', 'primary', async () => {
        view.error = null;
        try {
          await createPasskey();
          view.screen = 'role';
        } catch (err) {
          view.passkeyFailed = true;
          view.screen = 'password-create';
          if (err && err.message) view.error = err.message;
        }
        render();
      }),
      button('Use a password-encrypted key', 'ghost', () => {
        view.passkeyFailed = true;
        view.screen = 'password-create';
        render();
      }),
      button('Restore the paper key this extension showed', 'ghost', () => {
        view.passkeyFailed = true;
        view.screen = 'restore';
        render();
      })
    ])
  ]);
}

function renderPasswordCreate() {
  const password = h('input', { id: 'password', type: 'password', autocomplete: 'new-password' });
  const again = h('input', { id: 'password2', type: 'password', autocomplete: 'new-password' });
  return h('div', {}, [
    passwordNote(),
    h('p', {}, ['The password encrypts this profile\'s one key. The key stays in extension storage. It is not kept unlocked.']),
    field('Password', password),
    field('Repeat password', again),
    h('div', { class: 'row' }, [
      button('Save this profile\'s key', 'primary', async () => {
        view.error = null;
        if (password.value !== again.value) {
          view.error = 'The passwords do not match';
          password.value = '';
          again.value = '';
          render();
          return;
        }
        const chosen = password.value;
        password.value = '';
        again.value = '';
        view.busy = true;
        render();
        try {
          await createPassword(chosen);
          view.screen = 'role';
        } catch (err) {
          view.error = err.message || String(err);
        } finally {
          view.busy = false;
          render();
        }
      }),
      button('Back', 'ghost', () => {
        view.screen = 'start';
        render();
      })
    ])
  ]);
}

function renderRestore() {
  const words = h('textarea', { id: 'phrase', autocomplete: 'off', spellcheck: 'false' });
  const password = h('input', { id: 'password', type: 'password', autocomplete: 'new-password' });
  const check = h('input', { type: 'checkbox' });
  const label = h('label', {}, []);
  label.append(check, document.createTextNode(' This is the paper key this extension showed, not a Keeta Personal seed.'));
  return h('div', {}, [
    passwordNote(),
    h('p', {}, ['Type the 24 words this extension showed once. This does not import a Keeta Personal seed. The words are encrypted with the password and the words are not kept.']),
    field('Paper key', words),
    field('Password for this profile', password),
    label,
    h('div', { class: 'row' }, [
      button('Restore into this profile', 'primary', async () => {
        const phrase = words.value;
        const chosen = password.value;
        const confirmed = check.checked;
        words.value = '';
        password.value = '';
        view.busy = true;
        view.error = null;
        render();
        try {
          await restorePaper(phrase, chosen, confirmed);
          view.screen = 'role';
        } catch (err) {
          view.error = err.message || String(err);
          view.screen = 'restore';
        } finally {
          view.busy = false;
          render();
        }
      }),
      button('Back', 'ghost', () => {
        view.screen = 'start';
        render();
      })
    ])
  ]);
}

function renderRole() {
  const profile = view.profile;
  return h('div', {}, [
    passwordNote(),
    waitingNote(),
    h('p', {}, ['Give this public key to the other profile. Then either create the 2-of-3, or join one the other profile already published.']),
    kv([['This profile', profile.publicKey]]),
    h('div', { class: 'row' }, [
      copyButton(profile.publicKey),
      button('Create the 2-of-3', 'primary', async () => {
        view.error = null;
        if (profile.recoveryPublicKey) {
          view.screen = 'create-network';
          render();
          return;
        }
        view.busy = true;
        render();
        try {
          await makePaper();
          view.screen = 'paper';
        } catch (err) {
          view.error = err.message || String(err);
        } finally {
          view.busy = false;
          render();
        }
      }),
      button('Join an existing 2-of-3', 'ghost', () => {
        view.screen = 'join';
        render();
      }),
      refuseButton()
    ])
  ]);
}

function renderPaper() {
  const check = h('input', { id: 'wrote', type: 'checkbox' });
  const label = h('label', {}, []);
  label.append(check, document.createTextNode(' I wrote this on paper.'));
  return h('div', {}, [
    h('h2', {}, ['Write this on paper']),
    h('p', {}, ['These 24 words are the third key. This page shows them once. They are not stored. Two of the three keys must sign a send.']),
    view.phrase ? h('div', { class: 'words', id: 'words' }, view.phrase.split(' ').map((word, index) => h('span', {}, [(index + 1) + '. ' + word]))) : null,
    kv([['Paper key public key', view.recoveryPublic || '']]),
    label,
    h('div', { class: 'row' }, [
      button('Clear the phrase from this page', 'warn', async () => {
        if (!check.checked) {
          view.error = 'Confirm that you wrote the words on paper';
          render();
          return;
        }
        const pub = view.recoveryPublic;
        view.busy = true;
        view.error = null;
        try {
          await saveProfile({ ...view.profile, recoveryPublicKey: pub });
          view.phrase = null;
          view.recoveryPublic = null;
          view.screen = 'create-network';
          view.notice = 'The paper key is not on this page anymore. It cannot be shown again.';
        } catch (err) {
          view.error = err.message || String(err);
        } finally {
          view.busy = false;
          render();
        }
      })
    ])
  ]);
}

function renderCreateNetwork() {
  const coSigner = textInput('cosigner', view.profile.coSigner || '');
  return h('div', {}, [
    passwordNote(),
    waitingNote(),
    h('p', {}, ['Paste the other profile\'s public key. This publishes a 2-of-3 multisig and a storage account on the test network, then makes the multisig the only owner. A multisig address cannot be the account on a block, so sends move test KTA from the storage account.']),
    kv([
      ['This profile', view.profile.publicKey],
      ['Paper key public key', view.profile.recoveryPublicKey]
    ]),
    field('Other profile public key', coSigner),
    view.profile.method === 'password' ? field('Password', h('input', { id: 'password', type: 'password', autocomplete: 'current-password' })) : null,
    h('pre', { id: 'log', class: 'log' }, [view.log]),
    h('div', { class: 'row' }, [
      button('Publish on the test network', 'primary', async () => {
        const password = takePassword();
        const other = coSigner.value;
        view.busy = true;
        view.error = null;
        render();
        try {
          await publishSetup(password, other);
          view.notice = 'The storage account is owned by the 2-of-3.';
          view.screen = 'home';
          view.log = '';
        } catch (err) {
          view.error = err.message || String(err);
          view.screen = 'create-network';
        } finally {
          view.busy = false;
          render();
          if (view.screen === 'home') readBalances();
        }
      }),
      refuseButton()
    ])
  ]);
}

function renderJoin() {
  const multisig = textInput('multisig', '');
  const vault = textInput('vault', '');
  const coSigner = textInput('cosigner', '');
  return h('div', {}, [
    passwordNote(),
    waitingNote(),
    h('p', {}, ['Paste the multisig, the storage account, and the other signer. This profile does not make another paper key.']),
    kv([['This profile', view.profile.publicKey]]),
    field('Multisig', multisig),
    field('Storage account', vault),
    field('Other signer public key', coSigner),
    h('div', { class: 'row' }, [
      button('Save', 'primary', async () => {
        view.busy = true;
        view.error = null;
        render();
        try {
          await joinExisting(multisig.value, vault.value, coSigner.value);
          view.screen = chooseScreen();
          view.notice = 'This profile joined the 2-of-3.';
        } catch (err) {
          view.error = err.message || String(err);
          view.screen = 'join';
        } finally {
          view.busy = false;
          render();
          if (view.screen === 'home' || view.screen === 'send-loading') afterRender();
        }
      }),
      button('Back', 'ghost', () => {
        view.screen = 'role';
        render();
      }),
      refuseButton()
    ])
  ]);
}

function renderHome() {
  const profile = view.profile;
  const coSigner = textInput('cosigner', profile.coSigner || '');
  const paste = h('textarea', { id: 'paste' });
  const balance = view.balances && view.balances.error
    ? view.balances.error
    : (view.balances ? view.balances.mine + ' here, ' + view.balances.vault + ' in the storage account' : 'Reading balances.');
  return h('div', {}, [
    passwordNote(),
    waitingNote(),
    h('p', {}, ['Sends move test KTA from the storage account. This profile adds one signature share. Paste the other profile\'s payload here. Nothing is published until two shares are attached.']),
    kv([
      ['This profile', profile.publicKey],
      ['Multisig', profile.multisig],
      ['Storage account', profile.vault],
      ['Other signer', profile.coSigner],
      ['Paper key public key', profile.recoveryPublicKey || ''],
      ['Balances', balance, 'balance-line']
    ]),
    h('div', { class: 'row' }, [copyButton(profile.publicKey), copyButton(profile.multisig), copyButton(profile.vault)]),
    field('Other signer used on the next send', coSigner),
    h('div', { class: 'row' }, [
      button('Save other signer', 'ghost', async () => {
        view.error = null;
        try {
          const next = protocol.canonical(coSigner.value);
          if (!Account.fromPublicKeyString(next).isAccount()) throw new Error('The other signer must be a keyed account');
          if (next === profile.publicKey) throw new Error('The other signer is this profile');
          await saveProfile({ ...profile, coSigner: next });
          view.notice = 'The other signer for the next send was saved.';
        } catch (err) {
          view.error = err.message || String(err);
        }
        render();
      }),
      button('Request test KTA for fees', 'ghost', async () => {
        view.busy = true;
        view.error = null;
        render();
        try {
          const funded = await faucet(view.profile.publicKey);
          if (funded.httpStatus !== 200) throw new Error(funded.message || 'The test faucet refused this profile');
          await withRead(async (client) => waitForBalance(client, view.profile.publicKey));
          view.notice = 'The test faucet credited this profile.';
        } catch (err) {
          view.error = err.message || String(err);
        } finally {
          view.busy = false;
          render();
          readBalances();
        }
      })
    ]),
    h('h2', {}, ['Paste a payload']),
    paste,
    h('div', { class: 'row' }, [
      button('Review pasted payload', 'primary', async () => {
        const text = paste.value;
        view.busy = true;
        view.error = null;
        render();
        try {
          await preparePaste(text);
          view.screen = 'review';
        } catch (err) {
          view.error = err.message || String(err);
          view.screen = 'home';
        } finally {
          view.busy = false;
          render();
        }
      }),
      refuseButton()
    ])
  ]);
}

function renderReview() {
  const draft = view.draft;
  const described = draft.described;
  const originLabel = draft.mode === 'site'
    ? 'Origin'
    : 'Stated origin. This is not part of the signed block.';
  const amount = described.token === draft.baseToken
    ? protocol.formatDecimalAmount(described.amount) + ' KTA'
    : described.amount.toString() + ' raw units';
  return h('div', {}, [
    passwordNote(),
    h('p', {}, ['Nothing is signed until you approve. The publishing profile pays the fee from its own test KTA. One share is not published.']),
    kv([
      [originLabel, draft.origin || '—'],
      ['Destination', described.to],
      ['Token', described.token],
      ['Amount', amount],
      ['Fee', draft.feeError ? draft.feeError : feeText(draft.fees, draft.baseToken)],
      ['Storage account', described.account],
      ['Multisig', described.multisig],
      ['Signers', described.leaves.join(' and ')],
      ['Shares attached', String(draft.shares.length)]
    ]),
    view.profile.method === 'password'
      ? field('Password', h('input', { id: 'password', type: 'password', autocomplete: 'current-password' }))
      : null,
    h('div', { class: 'row' }, [
      button(approveLabel(), 'primary', () => { approve(); }),
      button('Back', 'ghost', () => {
        view.draft = null;
        view.screen = view.request && !view.answered ? 'home' : 'home';
        if (view.request && view.request.method === 'send' && !view.answered) view.screen = 'send-loading';
        render();
        afterRender();
      }),
      refuseButton()
    ])
  ]);
}

function renderConnect() {
  const profile = view.profile;
  return h('div', {}, [
    h('p', {}, ['Connecting does not sign anything.']),
    kv([
      ['Origin', view.request.origin || 'unknown'],
      ['Network', 'test'],
      ['This profile', profile.publicKey],
      ['Multisig', profile.multisig],
      ['Storage account', profile.vault]
    ]),
    h('div', { class: 'row' }, [
      button('Approve connection', 'primary', () => {
        respond({
          network: 'test',
          publicKey: profile.publicKey,
          multisig: profile.multisig,
          vault: profile.vault
        }, null);
        view.notice = 'The page was given this profile\'s public addresses. Nothing was signed.';
        view.screen = 'home';
        render();
        readBalances();
      }),
      refuseButton()
    ])
  ]);
}

function renderResult() {
  const outcome = view.result;
  const pretty = JSON.stringify(outcome.payload, null, 2);
  const area = h('textarea', { id: 'payload', readonly: 'readonly' });
  area.value = pretty;
  return h('div', {}, [
    outcome.published
      ? h('div', { class: 'ok' }, ['Published on the test network. Block ' + outcome.blockHash + '.'])
      : h('div', { class: 'note' }, ['One share is attached. This was not published. Paste this payload into the same extension in the other Chrome profile.']),
    area,
    h('div', { class: 'row' }, [
      copyButton(pretty),
      button('Back to this profile', 'ghost', () => {
        view.result = null;
        view.screen = 'home';
        render();
        readBalances();
      })
    ])
  ]);
}

function render() {
  const root = document.getElementById('app');
  root.replaceChildren(banner(), h('h1', {}, ['Keeta multisig signer']));
  if (view.error) root.append(h('div', { class: 'err' }, [view.error]));
  if (view.notice) root.append(h('div', { class: 'ok' }, [view.notice]));
  if (view.screen === 'loading' || view.screen === 'send-loading') {
    root.append(h('p', {}, [view.screen === 'send-loading' ? 'Reading the request from the test network. Nothing is signed yet.' : 'Loading.']));
    return;
  }
  const screens = {
    start: renderStart,
    'password-create': renderPasswordCreate,
    restore: renderRestore,
    role: renderRole,
    paper: renderPaper,
    'create-network': renderCreateNetwork,
    join: renderJoin,
    home: renderHome,
    review: renderReview,
    connect: renderConnect,
    result: renderResult,
    'review-error': () => h('div', {}, [
      h('p', {}, ['The request was not prepared.']),
      refuseButton()
    ])
  };
  const screen = screens[view.screen] || renderHome;
  root.append(screen());
}

function afterRender() {
  if (view.screen === 'home') readBalances();
  if (view.screen === 'send-loading' && !view.preparing) {
    view.preparing = true;
    prepareSiteSend().then(() => {
      view.preparing = false;
      view.screen = 'review';
      render();
    }).catch((err) => {
      view.preparing = false;
      view.error = err && err.message ? err.message : String(err);
      view.screen = 'review-error';
      render();
    });
  }
}

function readBalances() {
  if (!ready(view.profile)) return;
  withRead(async (client) => {
    const mine = await client.client.getBalance(view.profile.publicKey, client.baseToken);
    const vault = await client.client.getBalance(view.profile.vault, client.baseToken);
    return {
      mine: protocol.formatDecimalAmount(mine) + ' KTA',
      vault: protocol.formatDecimalAmount(vault) + ' KTA'
    };
  }).then((balances) => {
    view.balances = balances;
    const node = document.getElementById('balance-line');
    if (view.screen === 'home' && node) {
      node.textContent = balances.mine + ' here, ' + balances.vault + ' in the storage account';
    }
  }).catch((err) => {
    view.balances = { error: err.message || String(err) };
  });
}

window.addEventListener('beforeunload', (event) => {
  if (view.phrase) {
    event.preventDefault();
    event.returnValue = '';
  }
});

window.addEventListener('pagehide', () => {
  if (view.request && !view.answered) {
    chrome.storage.session.set({
      ['res:' + view.request.id]: {
        result: null,
        error: 'The request window was closed before approval.'
      }
    });
  }
});

async function boot() {
  try {
    view.salt = await signerSalt();
    view.profile = await loadProfile();
    const id = requestId();
    if (id) {
      const got = await chrome.storage.session.get('req:' + id);
      view.request = got['req:' + id] || null;
      if (!view.request) view.error = 'This request is no longer available.';
    }
    view.screen = chooseScreen();
  } catch (err) {
    view.error = err && err.message ? err.message : String(err);
    view.screen = view.profile ? chooseScreen() : 'start';
  }
  render();
  afterRender();
}

boot();
