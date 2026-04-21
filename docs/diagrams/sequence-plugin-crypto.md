Encryption key hierarchy and blob encryption flows for the Obsidian plugin's crypto module (v0.3).

## Key Generation and Recovery

How a master key is created and backed up as a 12-word recovery phrase.

```mermaid
sequenceDiagram
    participant User as User (Obsidian)
    participant Plugin as SS Sync Plugin
    participant Keys as crypto/keys.ts
    participant Server as Silent Stone API

    Note over User,Server: First-Time Vault Setup

    User->>Plugin: Create new vault
    Plugin->>Keys: generateMasterKey()
    Keys->>Keys: randomBytes(16) = 128-bit entropy
    Keys->>Keys: HKDF-SHA256(entropy) = 256-bit AES key
    Keys-->>Plugin: MasterKeyMaterial {key, entropy}

    Plugin->>Keys: masterKeyToRecoveryPhrase(material)
    Keys->>Keys: BIP39 encode entropy
    Keys-->>Plugin: 12-word mnemonic

    Plugin->>User: Display recovery phrase<br/>"Write these 12 words down"
    User->>Plugin: Confirm backup

    Note over User,Server: Wrap Master Key with Password

    Plugin->>Keys: wrapMasterKey(key, password)
    Keys->>Keys: randomBytes(16) = salt
    Keys->>Keys: Argon2id(password, salt) = KEK
    Keys->>Keys: AES-GCM encrypt key with KEK
    Keys-->>Plugin: WrappedKey {encryptedMasterKey, salt, argon2Params}

    Plugin->>Server: POST /api/vault/keys/setup<br/>{encryptedMasterKey, salt, argon2Params}
    Server-->>Plugin: 200 OK
    Plugin->>User: "Vault ready"
```

## Key Unwrap (Login on New Device)

How the master key is recovered when logging in on a different device.

```mermaid
sequenceDiagram
    participant User as User (New Device)
    participant Plugin as SS Sync Plugin
    participant Keys as crypto/keys.ts
    participant Server as Silent Stone API

    Note over User,Server: Existing Vault — New Device Login

    User->>Plugin: Enter password
    Plugin->>Server: GET /api/vault/keys
    Server-->>Plugin: {encryptedMasterKey, salt, argon2Params}

    Plugin->>Keys: unwrapMasterKey(input)
    Keys->>Keys: Argon2id(password, salt) = KEK
    Keys->>Keys: AES-GCM decrypt with KEK

    alt Correct password
        Keys-->>Plugin: 256-bit master key
        Plugin->>Plugin: Store key in memory<br/>(never persisted to disk)
        Plugin->>User: "Vault unlocked"
    else Wrong password
        Keys-->>Plugin: GCM auth tag failure
        Plugin->>User: "Wrong password"
    end
```

## Key Recovery (Lost Password)

How the master key is recovered using the 12-word BIP39 phrase.

```mermaid
sequenceDiagram
    participant User as User
    participant Plugin as SS Sync Plugin
    participant Keys as crypto/keys.ts
    participant Server as Silent Stone API

    Note over User,Server: Password Lost — Recovery Phrase Available

    User->>Plugin: Enter 12-word recovery phrase
    Plugin->>Keys: recoveryPhraseToMasterKey(phrase)
    Keys->>Keys: BIP39 decode = 128-bit entropy
    Keys->>Keys: HKDF-SHA256(entropy) = 256-bit AES key
    Keys-->>Plugin: MasterKeyMaterial {key, entropy}

    User->>Plugin: Enter NEW password
    Plugin->>Keys: wrapMasterKey(key, newPassword)
    Keys->>Keys: Argon2id(newPassword, newSalt) = new KEK
    Keys->>Keys: AES-GCM encrypt key with new KEK
    Keys-->>Plugin: New WrappedKey

    Plugin->>Server: PUT /api/vault/keys<br/>{encryptedMasterKey, salt, argon2Params}
    Server-->>Plugin: 200 OK
    Plugin->>User: "Key re-wrapped with new password"
```

## Blob Encryption (Sync Operations)

How vault files are encrypted before upload and decrypted after download.

```mermaid
sequenceDiagram
    participant Vault as Obsidian Vault
    participant Engine as Sync Engine
    participant Cipher as crypto/cipher.ts
    participant Client as VaultClient
    participant Server as Silent Stone API

    Note over Vault,Server: Upload (local file -> encrypted blob)

    Vault->>Engine: File changed
    Engine->>Vault: vault.read(file)
    Vault-->>Engine: plaintext bytes

    Engine->>Cipher: encryptBlob(plaintext, masterKey)
    Cipher->>Cipher: randomBytes(12) = nonce
    Cipher->>Cipher: AES-256-GCM encrypt
    Cipher-->>Engine: nonce || ciphertext || tag

    Engine->>Client: PUT /api/vault/blobs/:id
    Client->>Server: Encrypted blob (binary)
    Server-->>Client: 200 OK

    Note over Vault,Server: Download (encrypted blob -> local file)

    Engine->>Client: GET /api/vault/blobs/:id
    Client->>Server: Request blob
    Server-->>Client: Encrypted blob (binary)

    Engine->>Cipher: decryptBlob(encrypted, masterKey)
    Cipher->>Cipher: Split: nonce | ciphertext+tag
    Cipher->>Cipher: AES-256-GCM decrypt

    alt Valid (key matches, data intact)
        Cipher-->>Engine: plaintext bytes
        Engine->>Vault: vault.modify(file, plaintext)
    else Tampered or wrong key
        Cipher-->>Engine: GCM auth tag failure
        Engine->>Engine: Log error, skip file
    end
```

## Key Hierarchy Summary

```mermaid
graph TD
    Entropy["128-bit Random Entropy"]
    MK["256-bit Master Key<br/>(HKDF-SHA256)"]
    BIP["12-word BIP39 Phrase<br/>(human backup)"]
    PW["User Password"]
    Salt["Random Salt (16 bytes)"]
    KEK["256-bit KEK<br/>(Argon2id)"]
    Wrapped["Wrapped Master Key<br/>(AES-GCM)<br/>stored on server"]
    Blobs["Encrypted Vault Blobs<br/>(AES-256-GCM)<br/>stored on server"]

    Entropy -->|"HKDF-SHA256"| MK
    Entropy -->|"BIP39 encode"| BIP
    BIP -->|"BIP39 decode"| Entropy
    PW --> KEK
    Salt --> KEK
    KEK -->|"AES-GCM wrap"| Wrapped
    MK -->|"encrypt blobs"| Blobs
    MK -->|"wrapped by KEK"| Wrapped

    style MK fill:#f59e0b,stroke:#d97706,color:#000
    style KEK fill:#ef4444,stroke:#dc2626,color:#fff
    style Wrapped fill:#94a3b8,stroke:#64748b,color:#000
    style Blobs fill:#94a3b8,stroke:#64748b,color:#000
    style BIP fill:#4ade80,stroke:#16a34a,color:#000
    style Entropy fill:#a78bfa,stroke:#7c3aed,color:#000
```
