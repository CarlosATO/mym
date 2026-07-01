import json
import re

transcript_path = r"C:\Users\mympr\.gemini\antigravity-ide\brain\a5006fc1-da80-4fff-8521-1ecc800140d0\.system_generated\logs\transcript.jsonl"

stock_lines = {}
kardex_lines = {}

with open(transcript_path, 'r', encoding='utf-8') as f:
    for line in f:
        try:
            data = json.loads(line)
            if data.get('type') == 'VIEW_FILE' and data.get('status') == 'DONE':
                content = data.get('content', '')
                is_stock = 'stock-panel.tsx' in content
                is_kardex = 'kardex-panel.tsx' in content
                
                if is_stock or is_kardex:
                    # Parse lines like "1: 'use client'"
                    for c_line in content.split('\\n'):
                        match = re.match(r'^(\d+):\s(.*)$', c_line)
                        if match:
                            num = int(match.group(1))
                            text = match.group(2)
                            # Handle carriage returns
                            text = text.replace('\\r', '')
                            if is_stock:
                                stock_lines[num] = text
                            elif is_kardex:
                                kardex_lines[num] = text
        except Exception as e:
            pass

with open("recovered_stock_from_view.tsx", "w", encoding="utf-8") as f:
    for i in sorted(stock_lines.keys()):
        f.write(stock_lines[i] + "\n")

with open("recovered_kardex_from_view.tsx", "w", encoding="utf-8") as f:
    for i in sorted(kardex_lines.keys()):
        f.write(kardex_lines[i] + "\n")
