import re

transcript_path = r"C:\Users\mympr\.gemini\antigravity-ide\brain\a5006fc1-da80-4fff-8521-1ecc800140d0\.system_generated\logs\transcript.jsonl"

stock_candidates = []
kardex_candidates = []

with open(transcript_path, 'r', encoding='utf-8') as f:
    for line in f:
        if 'write_to_file' in line:
            if 'stock-panel.tsx' in line:
                match = re.search(r'"CodeContent":"(.*?)"(?:,"|\})', line)
                if match:
                    stock_candidates.append(match.group(1))
            if 'kardex-panel.tsx' in line:
                match = re.search(r'"CodeContent":"(.*?)"(?:,"|\})', line)
                if match:
                    kardex_candidates.append(match.group(1))

if stock_candidates:
    best_stock = max(stock_candidates, key=len)
    with open("best_stock.tsx", "w", encoding='utf-8') as f:
        f.write(best_stock.replace('\\n', '\n').replace('\\"', '"').replace('\\\\', '\\'))
    print(f"Recovered best stock-panel.tsx! Length: {len(best_stock)}")

if kardex_candidates:
    best_kardex = max(kardex_candidates, key=len)
    with open("best_kardex.tsx", "w", encoding='utf-8') as f:
        f.write(best_kardex.replace('\\n', '\n').replace('\\"', '"').replace('\\\\', '\\'))
    print(f"Recovered best kardex-panel.tsx! Length: {len(best_kardex)}")
