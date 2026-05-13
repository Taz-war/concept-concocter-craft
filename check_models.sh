#!/bin/bash
source .env
curl -s "https://generativelanguage.googleapis.com/v1/models?key=${GEMINI_API_KEY}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if 'models' not in data:
    print('ERROR:', json.dumps(data, indent=2))
    sys.exit(1)
for m in data['models']:
    methods = m.get('supportedGenerationMethods', [])
    if 'embedContent' in methods or 'batchEmbedContents' in methods:
        print(f\"EMBEDDING MODEL: {m['name']}  methods={methods}\")
" 2>&1
