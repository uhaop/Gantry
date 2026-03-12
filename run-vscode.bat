@echo off
setlocal
set DOTENV_CONFIG_PATH=.env.vscode
set DOTENV_CONFIG_OVERRIDE=true
pushd %~dp0
npx tsx src/index.ts
popd
