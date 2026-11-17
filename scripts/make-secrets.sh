#!/usr/bin/env bash
# Run once on k3s-1. Makes the bulk-to-text secrets, seals them into the cluster repo,
# registers the Argo CD app, and saves the login to ~/bulk-to-text-login.txt.
set -euo pipefail
export KUBECONFIG=$HOME/.kube/config
export PATH=$HOME/.local/bin:$PATH
cd ~/cluster
git pull -q

if [ -f secrets/bulk-to-text-secrets.yaml ]; then
  echo "Already done. The login is in ~/bulk-to-text-login.txt"
  exit 0
fi

rand() { openssl rand -hex 16; }
word() { shuf -n1 -e anker birk eng fjord hav hede kyst lyng mose skov sol strand vind aa bro dige; }
APP_PASSWORD="$(word)-$(word)-$(word)-$(openssl rand -hex 2)"
ANTHROPIC_API_KEY="$(kubectl -n lp-collection get secret lp-collection-anthropic -o jsonpath='{.data.ANTHROPIC_API_KEY}' | base64 -d)"

kubectl create secret generic bulk-to-text-secrets -n bulk-to-text --dry-run=client -o yaml \
  --from-literal=APP_PASSWORD="$APP_PASSWORD" \
  --from-literal=SESSION_SECRET="$(rand)$(rand)" \
  --from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  | kubeseal --controller-name sealed-secrets-controller --controller-namespace kube-system -o yaml \
  > secrets/bulk-to-text-secrets.yaml

cat > apps/bulk-to-text.yaml <<'APP'
# Manifests live in the app repo (deploy/); its CI bumps the image tag there.
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: bulk-to-text
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/PeyHunter/bulk-to-text.git
    targetRevision: main
    path: deploy
  destination:
    server: https://kubernetes.default.svc
    namespace: bulk-to-text
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
APP

kubectl create namespace bulk-to-text --dry-run=client -o yaml | kubectl apply -f - >/dev/null
git add apps/bulk-to-text.yaml secrets/bulk-to-text-secrets.yaml
git commit -qm "bulk-to-text: Argo app and sealed secrets"
git push -q

umask 077
printf 'bulk-to-text.peytonhunter.com\n\npassword  %s\n' "$APP_PASSWORD" > ~/bulk-to-text-login.txt
echo "Done. The login is saved in ~/bulk-to-text-login.txt on k3s-1."
