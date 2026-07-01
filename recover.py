import json
import sys

transcript_path = r"C:\Users\mympr\.gemini\antigravity-ide\brain\a5006fc1-da80-4fff-8521-1ecc800140d0\.system_generated\logs\transcript.jsonl"

stock_content = None
kardex_content = None

with open(transcript_path, 'r', encoding='utf-8') as f:
    for line in f:
        try:
            data = json.loads(line)
            if data.get('type') == 'PLANNER_RESPONSE':
                for tool_call in data.get('tool_calls', []):
                    if tool_call.get('name') == 'write_to_file':
                        args = tool_call.get('args', {})
                        target = args.get('TargetFile', '')
                        content = args.get('CodeContent', '')
                        if 'stock-panel.tsx' in target:
                            stock_content = content
                        elif 'kardex-panel.tsx' in target:
                            kardex_content = content
        except Exception as e:
            pass

if stock_content:
    with open("recovered_stock.tsx", "w", encoding='utf-8') as f:
        f.write(stock_content.strip('"').replace('\\n', '\n').replace('\\"', '"').replace('\\\\', '\\'))
    print("Recovered stock-panel.tsx!")

if kardex_content:
    with open("recovered_kardex.tsx", "w", encoding='utf-8') as f:
        f.write(kardex_content.strip('"').replace('\\n', '\n').replace('\\"', '"').replace('\\\\', '\\'))
    print("Recovered kardex-panel.tsx!")
