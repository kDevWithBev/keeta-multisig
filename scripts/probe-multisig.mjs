/**
 * Test network only.
 *
 * Create a 2-of-3 multisig with @keetanetwork/keetanet-client 0.18.7,
 * fund it from the public test faucet, publish one SEND signed by a single
 * multisig signer, then publish one SEND signed by two.
 *
 * Seeds are generated in memory and are not printed or written.
 * This process does not talk to mainnet and does not start a server.
 */
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const KeetaNet = require('@keetanetwork/keetanet-client');

const { Account, Block, Permissions } = KeetaNet.lib;
const FAUCET = 'https://faucet.test.keeta.com/';
const NETWORK = 'test';

const result = {
  client: '@keetanetwork/keetanet-client@0.18.7',
  network: NETWORK,
  startedAt: new Date().toISOString()
};

function publicAddress(account) {
  return account.publicKeyString.get();
}

function describeError(err) {
  if (err == null) {
    return null;
  }
  if (typeof err !== 'object') {
    return { message: String(err) };
  }
  const out = {
    name: err.name,
    message: err.message == null ? String(err) : String(err.message)
  };
  for (const key of ['code', 'errorCode', 'status', 'statusCode']) {
    if (err[key] !== undefined) {
      out[key] = typeof err[key] === 'bigint' ? err[key].toString() : err[key];
    }
  }
  if (err.cause) {
    out.cause = describeError(err.cause);
  }
  return out;
}

function log(step, detail) {
  const line = { step, ...detail };
  console.log(JSON.stringify(line));
  return line;
}

async function requestFaucet(address) {
  const body = `address=${encodeURIComponent(address)}&amount=10`;
  const response = await fetch(FAUCET, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const text = await response.text();
  return {
    url: FAUCET,
    httpStatus: response.status,
    contentType: response.headers.get('content-type'),
    bodySnippet: text.replace(/\s+/g, ' ').slice(0, 400)
  };
}

async function readBalance(client, account) {
  const balance = await client.client.getBalance(account, client.baseToken);
  return balance;
}

async function waitForBalance(client, account, minimum, timeoutMs) {
  const started = Date.now();
  let latest = 0n;
  while (Date.now() - started < timeoutMs) {
    latest = await readBalance(client, account);
    if (latest >= minimum) {
      return { balance: latest.toString(), waitedMs: Date.now() - started };
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return { balance: latest.toString(), waitedMs: Date.now() - started, timedOut: true };
}

async function publishSend(client, { account, multisig, signers, amount, to }) {
  const head = await client.client.getHeadBlock(account);
  const built = new Block.Builder({
    version: 2,
    purpose: Block.Purpose.GENERIC,
    account,
    signer: [multisig, signers],
    previous: head ? head.hash : Block.NO_PREVIOUS,
    network: client.network,
    operations: [{
      type: Block.OperationType.SEND,
      to,
      amount,
      token: client.baseToken
    }]
  });
  const block = await built.seal();
  const transmitted = await client.transmit([block]);
  return {
    accepted: transmitted.publish === true,
    blockHash: block.hash.toString(),
    publish: transmitted.publish,
    from: transmitted.from,
    signerCount: signers.length,
    signatures: block.signatures.length
  };
}

async function main() {
  const s1 = Account.fromSeed(Account.generateRandomSeed(), 0);
  const s2 = Account.fromSeed(Account.generateRandomSeed(), 0);
  const s3 = Account.fromSeed(Account.generateRandomSeed(), 0);
  result.signers = [publicAddress(s1), publicAddress(s2), publicAddress(s3)];
  log('signers', { addresses: result.signers });

  const client = KeetaNet.UserClient.fromNetwork(NETWORK, s1);
  result.networkId = client.network.toString();
  result.baseToken = publicAddress(client.baseToken);

  try {
    result.faucetSigner = await requestFaucet(publicAddress(s1));
    log('faucet-signer', result.faucetSigner);
    result.signerBalance = await waitForBalance(client, s1, 1n, 180000);
    log('signer-balance', result.signerBalance);
    if (result.signerBalance.balance === '0') {
      throw new Error('Test faucet did not fund the signer. Identifier was not created.');
    }

    const builder = client.initBuilder();
    const pending = builder.generateIdentifier({
      type: Account.AccountKeyAlgorithm.MULTISIG,
      signers: [s1, s2, s3],
      quorum: 2n
    });
    await builder.computeBlocks();
    const multisig = pending.account;
    result.multisig = publicAddress(multisig);
    result.quorum = '2';
    result.signerCount = 3;
    log('multisig-built', { address: result.multisig });

    try {
      const published = await builder.publish();
      result.identifier = {
        created: published.publish === true,
        publish: published.publish,
        from: published.from
      };
      if (published.voteStaple?.blocks?.[0]?.hash) {
        result.identifier.blockHash = published.voteStaple.blocks[0].hash.toString();
      }
    } catch (err) {
      result.identifier = { created: false, error: describeError(err) };
      log('identifier-refused', result.identifier);
      return;
    }
    log('identifier', result.identifier);
    if (!result.identifier.created) {
      return;
    }

    const info = await client.client.getAccountInfo(multisig);
    result.multisigInfo = {
      name: info?.info?.name ?? null,
      multisigQuorum: info?.info?.multisigQuorum == null ? null : info.info.multisigQuorum.toString()
    };
    log('multisig-info', result.multisigInfo);

    result.faucetMultisig = await requestFaucet(result.multisig);
    log('faucet-multisig', result.faucetMultisig);
    const direct = await waitForBalance(client, multisig, 1n, 90000);
    result.multisigBalanceAfterFaucet = direct;
    log('multisig-balance-after-faucet', direct);

    if (direct.balance === '0') {
      const signerBalance = BigInt(result.signerBalance.balance);
      const gift = signerBalance > 2n ? signerBalance / 2n : 1n;
      const head = await client.client.getHeadBlock(s1);
      const giftBuilder = new Block.Builder({
        version: 2,
        purpose: Block.Purpose.GENERIC,
        account: s1,
        previous: head ? head.hash : Block.NO_PREVIOUS,
        network: client.network,
        operations: [{
          type: Block.OperationType.SEND,
          to: multisig,
          amount: gift,
          token: client.baseToken
        }]
      });
      try {
        const giftBlock = await giftBuilder.seal();
        const gifted = await client.transmit([giftBlock]);
        result.transferToMultisig = {
          amount: gift.toString(),
          accepted: gifted.publish === true,
          publish: gifted.publish,
          from: gifted.from,
          blockHash: giftBlock.hash.toString()
        };
      } catch (err) {
        result.transferToMultisig = { amount: gift.toString(), accepted: false, error: describeError(err) };
      }
      log('transfer-to-multisig', result.transferToMultisig);
      result.multisigBalance = (await readBalance(client, multisig)).toString();
    } else {
      result.transferToMultisig = { skipped: true, reason: 'faucet credited the multisig directly' };
      result.multisigBalance = direct.balance;
    }
    log('multisig-balance', { balance: result.multisigBalance });

    const spend = result.multisigBalance && BigInt(result.multisigBalance) > 1n ? 1n : 1n;
    const recipient = publicAddress(s2);

    try {
      result.oneSignatureSend = await publishSend(client, {
        account: multisig,
        multisig,
        signers: [s1],
        amount: spend,
        to: s2
      });
    } catch (err) {
      result.oneSignatureSend = { accepted: false, error: describeError(err) };
    }
    log('one-signature-send', result.oneSignatureSend);

    if (result.oneSignatureSend.accepted === true) {
      result.stopped = 'one-signature send was accepted';
      return;
    }

    try {
      result.twoSignatureSend = await publishSend(client, {
        account: multisig,
        multisig,
        signers: [s1, s2],
        amount: spend,
        to: s2
      });
    } catch (err) {
      result.twoSignatureSend = { accepted: false, error: describeError(err) };
    }
    log('two-signature-send', result.twoSignatureSend);

    const oneReachedNetwork = result.oneSignatureSend?.publish !== undefined;
    const twoReachedNetwork = result.twoSignatureSend?.publish !== undefined;
    if (oneReachedNetwork || twoReachedNetwork) {
      return;
    }

    /*
     * The client refuses a block whose account is the multisig
     * (BLOCK_NO_MULTISIG_OP) before the network can vote. The quorum check
     * in this client runs when the multisig is the signer of a block on
     * another account. Ask the test network that question with a SEND.
     */
    const grant = client.initBuilder();
    grant.updatePermissions(
      multisig,
      new Permissions(['SEND_ON_BEHALF']),
      client.baseToken,
      Block.AdjustMethod.SET,
      { account: s1 }
    );
    try {
      const granted = await grant.publish();
      result.sendOnBehalfGrant = {
        accepted: granted.publish === true,
        publish: granted.publish,
        from: granted.from
      };
    } catch (err) {
      result.sendOnBehalfGrant = { accepted: false, error: describeError(err) };
      log('send-on-behalf-grant', result.sendOnBehalfGrant);
      return;
    }
    log('send-on-behalf-grant', result.sendOnBehalfGrant);

    const holderBalance = await readBalance(client, s1);
    const behalfAmount = holderBalance > 2n ? 1n : 1n;
    try {
      result.oneSignatureSendOnBehalf = await publishSend(client, {
        account: s1,
        multisig,
        signers: [s1],
        amount: behalfAmount,
        to: s3
      });
    } catch (err) {
      result.oneSignatureSendOnBehalf = { accepted: false, error: describeError(err) };
    }
    log('one-signature-send-on-behalf', result.oneSignatureSendOnBehalf);

    if (result.oneSignatureSendOnBehalf.accepted === true) {
      result.stopped = 'one-signature send-on-behalf was accepted';
      return;
    }

    try {
      result.twoSignatureSendOnBehalf = await publishSend(client, {
        account: s1,
        multisig,
        signers: [s1, s2],
        amount: behalfAmount,
        to: s3
      });
    } catch (err) {
      result.twoSignatureSendOnBehalf = { accepted: false, error: describeError(err) };
    }
    log('two-signature-send-on-behalf', result.twoSignatureSendOnBehalf);
  } finally {
    result.finishedAt = new Date().toISOString();
    await writeFile(new URL('../probe-result.json', import.meta.url), JSON.stringify(result, null, 2));
    console.log('RESULT ' + JSON.stringify(result, null, 2));
    if (typeof client?.destroy === 'function') {
      await client.destroy();
    }
  }
}

main().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('PROBE_FATAL ' + JSON.stringify(describeError(err)));
  console.error(err);
  process.exit(1);
});
