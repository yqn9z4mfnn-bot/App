# Backups criptografados (nuvem Link Claro)

Contém dump completo da nuvem (`.env`, DBs, filas GG, logs). **Nunca** commitar `.tar.gz` sem criptografia.

## Restaurar
```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -in cloud-backup-YYYYMMDD-HHMMSS.tar.gz.enc \
  -out cloud-backup.tar.gz
tar xzf cloud-backup.tar.gz
```
A senha de descriptografia é informada pelo admin (não fica no Git).
