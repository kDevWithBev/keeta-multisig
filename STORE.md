# Chrome Web Store listing

You submit this yourself. The publisher account has to be yours.

## Package

`keeta-multisig-0.2.0.zip` is the extension directory at the root of the zip. Upload that file. Do not upload the git repository.

## Fields

- Name: Keeta multisig signer
- Summary: 2-of-3 Keeta signer. One key per Chrome profile. Nothing is published until two profiles sign. Not audited.
- Category: Productivity
- Language: English
- Privacy policy URL: `https://github.com/surfingdegen/keeta-multisig/blob/main/PRIVACY.md`

The store sometimes rejects a GitHub blob URL. If it does, publish PRIVACY.md on a normal web page and use that address.

## Description

Keeta multisig signer keeps one signer key in one Chrome profile. A second profile adds the second signature. The third key is a 24-word paper key shown once. Write it on paper. It is not stored.

A spend moves KTA from a storage account owned by a 2-of-3 multisig. Nothing is published until two verified shares are attached. There is no relay and no server.

Choose the test network to practice. The main network moves real KTA and asks you to confirm that choice. This extension is not audited.

The profile that publishes pays the network fee from its own KTA. Finish both signatures within 5 minutes of the block time.

## Permission justifications

- storage: the encrypted signer and the public addresses for this profile.
- https://*.keeta.com/* and wss://*.keeta.com/*: publish blocks and read balances on the Keeta network.
- https://faucet.test.keeta.com/*: request practice KTA on the test network only.
- Content script on http and https pages: inject `window.keetaMultisig` so a site can request a connection. The script does not read page content. A send is not signed until the person approves it in the extension window.

## Review notes

Single purpose: sign and publish 2-of-3 Keeta spends from keys that stay in the browser. No remote code. No ads. No account system. The words "secure" and "audited" are not used as claims. The interface says "Not audited."
