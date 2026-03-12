@echo off
setlocal
set DOTENV_CONFIG_PATH=.env.cursor
pushd %~dp0
npx tsx src/index.ts
popd
