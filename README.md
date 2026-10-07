# keeta-multisig

Test network only. Not audited. One key per profile.

This is an unpacked Chrome extension. It is not published to the Chrome Web Store. It does not use a server, a relay, mainnet, or a Keeta Personal seed.

The client is `@keetanetwork/keetanet-client` 0.18.7. `AccountKeyAlgorithm.MULTISIG` is the source for the identifier. The public docs do not describe it.

## One-signature result

A 2-of-3 identifier was created on the test network (`quorum` 2, `publish: true`). The test faucet refused the multisig address (`HTTP 400`, page text `An error occurred: Invalid address type: MULTISIG`). A faucet-funded key then sent `5000000000000000000` base units to the multisig, and that balance was visible.

A send whose block account is the multisig cannot be built. One signer and two signers both failed in the client before a representative voted:

```
Cannot create a block for a multisig account
```

`code: BLOCK_NO_MULTISIG_OP`

The send the network could vote on puts the multisig in the signer field of a block on another account, after `SEND_ON_BEHALF` for the base token was published. One signature was not accepted. The client returned this verbatim:

```
Quorum of 2 not reached for keeta_a6uxgzd67kcrpjgzr2dzzwosigahtu4r5yamvilcazqktak454o47lmuv5ekw -- got 1
```

`code: LEDGER_INVALID_PERMISSIONS`

The same send signed by two signers was accepted (`publish: true`, block `6B84A3C374BDB9383C25484344683FAF18458B43D1FF7B660A99B82D530E3264`).

The extension publishes only when two signature shares are attached to that kind of block. It does not keep an off-chain approval list.

## Load the unpacked extension

From the tagged commit, after `git clone`:

```
git clone https://github.com/surfingdegen/keeta-multisig.git
cd keeta-multisig
git checkout v0.1.0
```

Chrome: `chrome://extensions` → Developer mode → Load unpacked → the `extension/` directory in that checkout.

Use a separate Chrome profile for each signer. The recovery phrase is shown once. Write it on paper. It is not stored.
