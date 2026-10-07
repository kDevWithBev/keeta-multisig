# Privacy policy

Keeta multisig signer is a Chrome extension. It is not audited. There is no account with the publisher and no analytics.

## What stays on this computer

Each Chrome profile stores one signer. The private key is encrypted with a password, or created from a passkey, and kept in `chrome.storage.local` for that profile. It is not synced and it is not sent to the publisher. The 24-word paper key is shown once and is not stored. The extension does not call `exportPassphrase`.

The profile also stores the public addresses it needs: this profile, the multisig, the storage account, the other signer, and the network choice (test or main).

## What leaves this computer

Signing and publishing contact the Keeta network for the network you chose (`https://*.keeta.com` and `wss://*.keeta.com`). On the test network only, a request for practice KTA goes to `https://faucet.test.keeta.com`. There is no faucet call on the main network.

A site that calls `window.keetaMultisig` can receive the public addresses after you approve a connection. A send is not signed until you approve it in the extension window. The site receives the payload you approved. The extension does not read the page's other content.

## Permissions

`storage` holds the encrypted key and the public addresses. Host access to Keeta is how blocks are published. The content script injects the provider into http and https pages so a site can request a connection. It does not scrape the page.

## Contact

The source is [github.com/surfingdegen/keeta-multisig](https://github.com/surfingdegen/keeta-multisig).
