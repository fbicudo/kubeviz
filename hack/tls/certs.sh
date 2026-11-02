#!/usr/bin/env bash
# Gera uma CA local e um certificado para o KubeViz, para que o navegador
# confie nele (sem aviso) e aceite passkeys, que o Chrome bloqueia em sites
# com erro de certificado.
#
# A CA é restrita por nome (nameConstraints): só vale para os nomes e IPs
# informados. Instalá-la no navegador não lhe dá poder sobre outros sites.
#
# Uso: hack/tls/certs.sh <diretório> <nome|ip>...
#   ex.: hack/tls/certs.sh ~/.config/kubeviz/tls 10.11.12.103.nip.io 10.11.12.103 localhost 127.0.0.1
# Gera ca.crt (instalar no navegador ou no sistema), ca.key, tls.crt e tls.key.
# Rodar de novo renova só o certificado do servidor (a CA é mantida).
set -euo pipefail

dir="${1:?informe o diretório}"
shift
[[ $# -gt 0 ]] || { echo "informe ao menos um nome ou IP" >&2; exit 2; }

san=() permitted=()
for n in "$@"; do
  if [[ "$n" =~ ^[0-9.]+$ ]]; then
    san+=("IP:$n") permitted+=("permitted;IP:$n/255.255.255.255")
  else
    san+=("DNS:$n") permitted+=("permitted;DNS:$n")
  fi
done
join() { local IFS=,; echo "$*"; }

umask 077
mkdir -p "$dir"
cd "$dir"
if [[ ! -s ca.key ]]; then
  openssl req -x509 -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout ca.key -out ca.crt -days 825 -subj "/CN=KubeViz CA ($1)" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "nameConstraints=critical,$(join "${permitted[@]}")" 2>/dev/null
  echo "CA criada: $dir/ca.crt (restrita a: $*)"
fi
ext="$(mktemp)"
trap 'rm -f "$ext" server.csr' EXIT
cat > "$ext" <<EXT
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = $(join "${san[@]}")
authorityKeyIdentifier = keyid
EXT
openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout tls.key.new -out server.csr -subj "/CN=$1" 2>/dev/null
# 397 dias: limite aceito pelos navegadores para certificados de servidor.
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out tls.crt.new -days 397 -extfile "$ext" 2>/dev/null
chmod 644 ca.crt tls.crt.new
mv tls.crt.new tls.crt
mv tls.key.new tls.key
echo "Certificado: $dir/tls.crt e tls.key (o KubeViz relê sozinho, sem reiniciar)"
