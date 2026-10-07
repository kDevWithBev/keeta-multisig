# keeta-multisig

One Chrome profile holds one signer key. A spend needs a second profile. The third key is a 24-word paper key shown once. Not audited.

The extension can talk to the Keeta test network or the main network. The quorum behavior below was proven on the test network. Mainnet uses the same construction. A mistake on mainnet can move real KTA. There is no faucet on mainnet.

This does not use a server, a relay, or a Keeta Personal seed. The client is `@keetanetwork/keetanet-client` 0.18.7. `AccountKeyAlgorithm.MULTISIG` is the source for the identifier. The public docs do not describe it.

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

## Storage account

The extension does not put the multisig address in the block account field. That construction cannot be published (`BLOCK_NO_MULTISIG_OP`). It publishes a storage account, allows that account to hold the base token, asks the test faucet for KTA, then sets the 2-of-3 as the only owner. A send is one `SEND` on that storage account. The signer is the multisig plus exactly two of its three keys.

A later test-network run of that ownership path rejected one signature:

```
Quorum of 2 not reached for keeta_a4dmetpi4hoyou2uxrrfi6jqrql6byjqeaopr63yab6eq6czpqiohmzhvchca -- got 1
```

`code: LEDGER_INVALID_PERMISSIONS`

Two signatures were accepted (`publish: true`, block `144BF8C63275376EDAEF9FDF2EF156B0B27F42839C2A38CEF92E9C9768122B52`).

The extension publishes only when two verified signature shares are attached to that kind of block. It does not keep an off-chain approval list. A payload with one share is not published.

## Two Chrome profiles

Each profile holds one signer and no other.

1. Load the extension in profile A and profile B.
2. Profile B creates its signer and copies its public key.
3. Profile A creates its signer. It tries a passkey with the salt label `github.com/surfingdegen/keeta-multisig/signer/v1`, which is not `keeta.com/wallet/seed/v1`. If the passkey ceremony fails, the screen says the profile keeps a password-encrypted key in extension storage.
4. Profile A shows a 24-word paper key once. Write it on paper. It is not stored. That public key is the third signer.
5. Profile A pastes profile B's public key and publishes the 2-of-3 and the storage account.
6. Profile B pastes the multisig, the storage account, and profile A's public key.

The unlocked key is used for the signing call and then dropped. It is not kept for a later call. The extension does not call `exportPassphrase`. Restore accepts only the paper key this extension showed. It does not import a Keeta Personal seed.

A page talks to `window.keetaMultisig` through the injected provider. `connect()` returns the public addresses and does not sign. `send({ to, amount, token })` opens the approval window. `amount` is a decimal string with up to 18 decimal places. `token` defaults to that network's base token. The window shows the origin, destination, token, amount, and fee quote before anything is signed. Approving adds one signature share and returns the payload. It does not publish.

Paste that payload into the other profile. That profile shows the same block fields. The origin in the payload is labeled as the stated origin and is not part of the signed block. Approving there adds the second share and publishes. The publishing profile pays the network fee from its own test KTA. Request that from the test faucet in the profile that will publish.

To spend with the paper key, load the extension in a third profile and restore those words, then paste the multisig, the storage account, and one of the other public keys. On the profile that still has its key, put the paper key's public key in “Other signer used on the next send” before building a new payload. There is no relay.

## Load it

```
git clone https://github.com/surfingdegen/keeta-multisig.git
cd keeta-multisig
git checkout v0.2.0
```

Chrome: `chrome://extensions` → Developer mode → Load unpacked → the `extension/` directory.

Use a separate Chrome profile for each signer. On the first screen, choose the test network until a small send has worked. The main network requires the confirmation checkbox. The recovery phrase is shown once. Write it on paper. It is not stored.

The home screen buttons are labeled **Copy this profile**, **Copy multisig**, and **Copy storage account**. The joining profile pastes them in that order: multisig, storage account, then the other profile's public key.

Finish both signatures within 5 minutes of the block time. A representative refuses an older block. If the fee line says the network did not return a quote, you can still sign. The profile that publishes pays the fee from its own KTA.

`demo/index.html` calls `window.keetaMultisig`. Serve it over http. The extension does not inject into `file://` pages.

## Chrome Web Store

The upload package is `keeta-multisig-0.2.0.zip`. Listing text is in [STORE.md](STORE.md). The privacy policy is [PRIVACY.md](PRIVACY.md). Publishing requires your own Chrome Web Store developer account. This repository does not submit the listing for you.
