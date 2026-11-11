#!/usr/bin/env bash
# For Andreas, in his own terminal (not an agent): makes the new backup key pair. The private key goes only into a
# passphrase-protected file you choose (USB stick, plus the passphrase in a password manager); agents get only the public key.
#   ~/copybook-api/ops/new-backup-key.sh /run/media/$USER/<stick>/copybook-backup-key.age
set -euo pipefail
export PATH=$HOME/copybook-api/bin:$PATH
out=${1:?usage: new-backup-key.sh <path for the passphrase-protected key file>}
[ -e "$out" ] && { echo "$out exists; not overwriting"; exit 1; }
key=$(age-keygen 2>/dev/null)
pub=$(printf '%s\n' "$key" | age-keygen -y)
echo "Choose a passphrase for the key file (age asks twice); save it in your password manager."
printf '%s\n' "$key" | age -p -o "$out"
unset key
echo "Checking the file opens with your passphrase (age asks once more):"
[ "$(printf ok | age -r "$pub" | age -d -i "$out")" = ok ] || { echo "check failed; nothing changed"; exit 1; }
printf '%s\n' "$pub" > "$HOME/copybook-api/backup.pub.new"
echo "Done. Public key $pub is in ~/copybook-api/backup.pub.new; agents re-encrypt the backups to it next."
echo "Keep $out (and a second copy) offline. Nothing else needs the private key except the monthly restore drill."
