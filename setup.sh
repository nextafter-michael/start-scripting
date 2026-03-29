#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "Installing dependencies..."
npm install
echo "Linking ss command globally..."
npm link
echo
echo "Done. Run 'ss --version' to verify."
