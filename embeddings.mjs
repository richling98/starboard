const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

export function embeddingModel() {
  return process.env.STARBOARD_EMBEDDING_MODEL || "text-embedding-3-small";
}

export function embeddingDimensions() {
  return Number(process.env.STARBOARD_EMBEDDING_DIMENSIONS || 1024);
}

export async function createEmbeddings(inputs, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.STARBOARD_OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY or STARBOARD_OPENAI_API_KEY is not configured.");
  }
  const input = Array.isArray(inputs) ? inputs : [inputs];
  const model = options.model || embeddingModel();
  const dimensions = Number(options.dimensions || embeddingDimensions());
  if (!input.length) {
    return {
      embeddings: [],
      usage: { prompt_tokens: 0, total_tokens: 0 },
      model,
      dimensions
    };
  }

  const response = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      input,
      model,
      dimensions
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `OpenAI embeddings request failed: ${response.status}`);
  }

  return {
    embeddings: (data.data || [])
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding),
    usage: {
      prompt_tokens: Number(data.usage?.prompt_tokens || 0),
      total_tokens: Number(data.usage?.total_tokens || 0)
    },
    model,
    dimensions
  };
}

export async function createEmbedding(input, options = {}) {
  const { embeddings } = await createEmbeddings([input], options);
  const [embedding] = embeddings;
  return embedding;
}
