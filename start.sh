#!/bin/sh
# Serves Nexus Type at http://localhost:5173 and opens it in your browser.
# Uses the Ruby that ships with macOS, so nothing needs installing.
cd "$(dirname "$0")"
PORT=${PORT:-5173}
(sleep 1 && open "http://localhost:$PORT") &
PORT=$PORT exec ruby server.rb
