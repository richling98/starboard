const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

export function embeddingModel() {
  return process.env.STARBOARD_EMBEDDING_MODEL || "text-embedding-3-small";
}

export function embeddingDimensions() {
  return Number(process.env.STARBOARD_EMBEDDING_DIMENSIONS || 1024);
}

export async function createEmbeddings(inputs, options = {}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
  const input = Array.isArray(inputs) ? inputs : [inputs];
  if (!input.length) return [];

  const response = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      input,
      model: options.model || embeddingModel(),
      dimensions: Number(options.dimensions || embeddingDimensions())
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `OpenAI embeddings request failed: ${response.status}`);
  }

  return (data.data || [])
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

export async function createEmbedding(input, options = {}) {
  const [embedding] = await createEmbeddings([input], options);
  return embedding;
}
