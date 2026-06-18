# Publish workflow auto-publishes @zaganjade/* workspaces to:
#   - npm registry.npmjs.org      (secret: NPM_TOKEN)
#   - GitHub Packages             (secret: GITHUB_TOKEN, auto)
# Manual local publish to GitHub Packages (needs PAT with write:packages):
#
#   GH_PAT=ghp_xxx
#   npm publish --workspace usage --registry=https://npm.pkg.github.com --//npm.pkg.github.com/:_authToken=$GH_PAT
#   npm publish --workspace multi-skill --registry=https://npm.pkg.github.com --//npm.pkg.github.com/:_authToken=$GH_PAT
