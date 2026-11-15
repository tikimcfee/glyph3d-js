//! g3d-vendor: check a download against its minisign signature, for tools/termd-vendor.sh.
//!
//!   g3d-vendor verify <public key (base64)> <file> <file.minisig>
//!
//! Exits 0 when the signature is good: made by that key, over the file's bytes (a prehashed
//! signature: both Ghostty and Zig sign so), with a trusted comment naming the file
//! (`file:<name>`, so a signature over another release's file doesn't pass). Anything else
//! exits 1 saying why. The script also checks each file against its pinned SHA-256.

use minisign_verify::{PublicKey, Signature};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::process::ExitCode;

fn verify(key: &str, file: &Path, sig: &Path) -> Result<(), String> {
    let key = PublicKey::from_base64(key).map_err(|e| format!("public key {key}: {e}"))?;
    let text = std::fs::read_to_string(sig).map_err(|e| format!("{}: {e}", sig.display()))?;
    let sig_parsed = Signature::decode(&text).map_err(|e| format!("{}: {e}", sig.display()))?;
    let name = file.file_name().and_then(|n| n.to_str()).ok_or_else(|| format!("{}: no file name", file.display()))?;
    let names_file = sig_parsed.trusted_comment().split('\t').any(|field| field == format!("file:{name}"));
    if !names_file {
        return Err(format!(
            "{}: its trusted comment ({}) does not name {name}",
            sig.display(),
            sig_parsed.trusted_comment()
        ));
    }
    let mut stream = key.verify_stream(&sig_parsed).map_err(|e| format!("{}: {e}", sig.display()))?;
    let mut f = File::open(file).map_err(|e| format!("{}: {e}", file.display()))?;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("{}: {e}", file.display()))?;
        if n == 0 {
            break;
        }
        stream.update(&buf[..n]);
    }
    stream.finalize().map_err(|e| format!("{}: {e}", file.display()))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [cmd, key, file, sig] = args.as_slice() else {
        eprintln!("usage: g3d-vendor verify <public key> <file> <file.minisig>");
        return ExitCode::from(2);
    };
    if cmd != "verify" {
        eprintln!("g3d-vendor: unknown command {cmd} (usage: g3d-vendor verify <public key> <file> <file.minisig>)");
        return ExitCode::from(2);
    }
    match verify(key, Path::new(file), Path::new(sig)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("g3d-vendor: signature check failed: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::verify;
    use std::path::PathBuf;

    // minisign-verify's own prehashed vector: key E7620F1842B4E81F signing "test" as file:test.
    const KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIG: &str = "untrusted comment: signature from minisign secret key
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=
trusted comment: timestamp:1556193335\tfile:test
y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==
";

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("g3d-vendor-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(d: &std::path::Path, name: &str, bytes: &[u8]) -> (PathBuf, PathBuf) {
        let file = d.join(name);
        let sig = d.join(format!("{name}.minisig"));
        std::fs::write(&file, bytes).unwrap();
        std::fs::write(&sig, SIG).unwrap();
        (file, sig)
    }

    #[test]
    fn good_signature_passes() {
        let d = dir("good");
        let (file, sig) = write(&d, "test", b"test");
        assert_eq!(verify(KEY, &file, &sig), Ok(()));
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn changed_bytes_fail() {
        let d = dir("bytes");
        let (file, sig) = write(&d, "test", b"Test");
        let err = verify(KEY, &file, &sig).unwrap_err();
        assert!(err.contains("signature verification failed"), "{err}");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn another_files_signature_fails() {
        let d = dir("name");
        let (file, sig) = write(&d, "other", b"test");
        let err = verify(KEY, &file, &sig).unwrap_err();
        assert!(err.contains("does not name other"), "{err}");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn another_key_fails() {
        let d = dir("key");
        let (file, sig) = write(&d, "test", b"test");
        // Zig's key: a real key, not the one that made this signature.
        let err = verify("RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U", &file, &sig).unwrap_err();
        assert!(err.contains("key"), "{err}");
        std::fs::remove_dir_all(d).unwrap();
    }
}
