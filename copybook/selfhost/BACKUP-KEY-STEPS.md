Taking the Copybook backup key out of agents' reach (Andreas; any day from Tue Nov 17; about 10 minutes)

Why a new key rather than saving the current one: the current private key has been in the Amp runner's environment,
which agents can read, so a copy kept offline wouldn't take it out of their reach. A key you generate yourself never is.
All backups are re-encrypted to it, so the 30 days of retention stay restorable, and the old key then opens nothing kept.

1. In your own terminal on gene, with a USB stick mounted:
     ~/copybook-api/ops/new-backup-key.sh /run/media/$USER/<stick>/copybook-backup-key.age
   Choose a passphrase (age asks twice, then once more to check) and save it in 1Password. Copy the .age file to a
   second offline place (another stick, or a 1Password document). Agents only ever see the public key it prints.
2. Tell the Copybook API thread on gene: "backup key made". The agent runs rewrap-backups.sh (every R2 backup and the
   hourly local ones, each checked against its manifest), takes a fresh backup, runs backup-verify.sh, and confirms.
3. After it confirms: Amp Settings -> Secrets -> delete COPYBOOK_BACKUP_AGE_KEY. The running Amp runner keeps the old
   value in its environment until it restarts, so restart it when convenient
   (systemctl --user restart amp-runner). That ends agent shells in progress; the nf-* jobs run as separate units and
   keep running.
4. Monthly (first Monday; the weekly check asks you): run the decrypt drill yourself and paste its last line (counts only):
     AGE_KEY_FILE=/run/media/$USER/<stick>/copybook-backup-key.age ~/copybook-api/ops/restore-check.sh
   age asks for the passphrase. A restore onto another machine (RESTORE.md Option B) also needs you from then on.

What this does not change: agents still run as the account that owns the live data (~/copybook-api/state), so they can
read the live store until the service-user script (setup-service-user.sh) runs. The key change protects backups only.
