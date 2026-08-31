# Providers

Sensei talks to any of four endpoint kinds through one provider layer:

| Provider | Wire protocol | Key |
|---|---|---|
| `anthropic` (built-in) | Anthropic Messages API | `ANTHROPIC_API_KEY` |
| `openai` (built-in) | OpenAI chat completions | `OPENAI_API_KEY` |
| `local` (built-in) | OpenAI wire → Ollama | none |
| custom entries | either wire, your URL | your env var |

The key design point: a provider entry declares its **wire protocol** (`openai` or
`anthropic`) separately from the model — because a company gateway can serve Claude
models over the OpenAI wire, or sit at a custom path speaking the Anthropic wire.

## How the active provider is chosen

Highest to lowest priority:

1. `--provider <name>` on the command line
2. `--local` (alias for `--provider local`)
3. `"provider"` in config
4. **Inference from the model name**: `claude-*` → `anthropic`, everything else → `openai`

So with `ANTHROPIC_API_KEY` set, `sensei --model claude-opus-5` just works — no provider
config at all.

## Company gateway setup

One entry in `~/.sensei/config.json`:

```jsonc
{
  "provider": "company",
  "providers": {
    "company": {
      "wire": "anthropic",                     // which protocol the gateway speaks
      "base_url": "https://llm-gw.corp.example/anthropic",
      "api_key_env": "COMPANY_LLM_TOKEN",      // env var checked first
      "api_key": null,                         // literal fallback; "none" = no auth (mTLS/VPN)
      "auth": "bearer",                        // "x-api-key" (anthropic default) | "bearer"
      "headers": { "x-corp-project": "sensei" },  // extra headers, sent verbatim
      "model": "claude-opus-5",                // optional per-provider model
      "prompt_caching": true,                  // anthropic wire only (default true)
      "stream_usage": true                     // openai wire only — set false for gateways
                                               // that reject stream_options
    }
  }
}
```

Then:

```powershell
$env:COMPANY_LLM_TOKEN = "..."
sensei --provider company        # or rely on "provider": "company" in config
```

Notes:

- User entries **deep-merge over the built-ins**, so you can point the built-in
  `anthropic` provider at a proxy by adding `"providers": {"anthropic": {"base_url": ...}}`.
- If no key resolves, sensei fails preflight with a message naming the exact env var.
- `"api_key": "none"` marks a keyless gateway (ambient mTLS/VPN auth).
- On the OpenAI wire, a custom `base_url` also switches the token parameter from
  `max_completion_tokens` (api.openai.com) to `max_tokens`, which OpenAI-compatible
  servers (gateways, Ollama) expect.

## Switching at runtime

- `/provider` — lists every configured provider with its wire, endpoint, and key status
  (`✓ key` / `✗ no key`); `/provider <name>` switches and persists.
- `/model <name>` — sets the model for the active provider (persists). Changing to a
  `claude-*` name re-infers the provider when none was set explicitly.
- Sessions remember their provider: `--continue` re-selects the provider the session was
  saved under unless you override with a flag.

## Prompt caching and cost

On the Anthropic wire, prompt caching is **on by default**: the system prompt, tool
definitions, and the growing conversation prefix carry `cache_control` breakpoints, so
each agent round re-reads the previous round's prefix at ~0.1× the input price (cache
writes cost ~1.25×). The cost line reports it:

```
tokens ~120.3k in / 4.1k out (~980.2k cached) | model claude-opus-5 | ~$1.2345
```

Cached tokens are billed separately from `input` tokens — sensei's cost math accounts for
both without double-counting. If a gateway rejects `cache_control`, set
`"prompt_caching": false` on that provider entry.

Model prices are built in for current Claude and GPT models; override or add any model in
config: `"prices": { "my-model": [5.0, 25.0] }` ($/1M input, output). Local models always
cost $0.

## Local Ollama

```
sensei --local                    # default endpoint http://localhost:11434, model qwen3:14b
```

Config keys: `local_model`, `local_base_url`. The `log_search` semantic-search tool also
uses Ollama embeddings (`embed_model`, default `nomic-embed-text`) and is only available
in local mode.
