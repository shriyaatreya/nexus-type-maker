#!/bin/sh
# Stamps a fresh version tag on the CSS, the main script and every module
# import (styles.css?v=…, app.js?v=…, './layout.js?v=…'), so browsers fetch
# matching new files after each update instead of reusing stale cached ones.
# Run it before committing a change: sh bump-version.sh
cd "$(dirname "$0")"
V=$(date +%Y%m%d%H%M)

sed -i '' -E \
  -e "s#href=\"styles\.css(\?v=[0-9]+)?\"#href=\"styles.css?v=$V\"#" \
  -e "s#src=\"js/app\.js(\?v=[0-9]+)?\"#src=\"js/app.js?v=$V\"#" \
  index.html

for f in js/*.js; do
  sed -i '' -E "s#from '\./([a-z]+)\.js(\?v=[0-9]+)?'#from './\1.js?v=$V'#g" "$f"
done

echo "Version $V"
