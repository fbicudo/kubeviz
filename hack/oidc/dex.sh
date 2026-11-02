#!/usr/bin/env bash
# Sobe um Dex local (http://127.0.0.1:5556/dex) para testar o login OIDC do
# KubeViz e aplica as permissões dos usuários de teste no kind.
#
# A senha da usuária ana@kubeviz.test e o client secret são aleatórios e
# ficam em ~/.config/kubeviz/oidc-demo (fora do repositório).
#
# Uso: hack/oidc/dex.sh [up|down]     (DOCKER="sudo docker" se preciso)
set -euo pipefail

DOCKER="${DOCKER:-docker}"
IMAGE="ghcr.io/dexidp/dex:v2.44.0"
here="$(cd "$(dirname "$0")" && pwd)"
dir="${KUBEVIZ_OIDC_DEMO_DIR:-$HOME/.config/kubeviz/oidc-demo}"
kubeviz="${KUBEVIZ:-$here/../../bin/kubeviz}"

if [[ "${1:-up}" == down ]]; then
  $DOCKER rm -f kubeviz-dex > /dev/null
  echo "Dex removido."
  exit 0
fi

umask 077
mkdir -p "$dir"
random() { head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24; }
[[ -s "$dir/password" ]] || random > "$dir/password"
[[ -s "$dir/client-secret" ]] || random > "$dir/client-secret"

# O hash bcrypt da senha vem do próprio kubeviz (mesmo formato do Dex).
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
"$kubeviz" user add ana --users-file "$tmp/users" < "$dir/password" > /dev/null
hash="$(grep -o '"passwordHash": "[^"]*"' "$tmp/users" | cut -d'"' -f4)"
[[ "$hash" == \$2* ]] || { echo "não foi possível gerar o hash da senha" >&2; exit 1; }
sed -e "s|@HASH@|$hash|" -e "s|@SECRET@|$(cat "$dir/client-secret")|" "$here/dex.yaml" > "$dir/dex.yaml"
chmod 644 "$dir/dex.yaml" # lido pelo usuário do container

$DOCKER rm -f kubeviz-dex > /dev/null 2>&1 || true
$DOCKER run -d --name kubeviz-dex --network host \
  -v "$dir/dex.yaml:/etc/dex/config.yaml:ro" "$IMAGE" dex serve /etc/dex/config.yaml > /dev/null
kubectl --context kind-kubeviz-dev apply -f "$here/rbac.yaml" > /dev/null

cat <<MSG
Dex em http://127.0.0.1:5556/dex
  usuária: ana@kubeviz.test (só leitura em demo)
  senha:   $dir/password
  ou "Exemplo com grupos": kilgore@kilgore.trout, grupo authors (edição em demo)

Inicie o KubeViz com:
  ./bin/kubeviz --kubeconfig ~/.kube/kubeviz-demo.yaml \\
    --oidc-issuer-url http://127.0.0.1:5556/dex --oidc-client-id kubeviz \\
    --oidc-client-secret-file $dir/client-secret \\
    --oidc-redirect-url http://127.0.0.1:4466/auth/oidc/callback \\
    --oidc-scopes openid,profile,email,groups,offline_access --oidc-display-name Dex
MSG
