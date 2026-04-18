export type SearchApiResult = {
  chunk_id: string;
  memory_id: string;
  chunk_index: number;
  text: string;
  score: number;
  _explain?: unknown;
};

export type MemorySearchRow = {
  key: string;
  memoryId: string;
  chunkId: string;
  chunkIndex: number;
  text: string;
  score: number;
  explain?: unknown;
};

export function mapSearchResultsToRows(results: SearchApiResult[]): MemorySearchRow[] {
  return results.map((result) => ({
    key: `${result.chunk_id}:${result.memory_id}:${result.chunk_index}`,
    memoryId: result.memory_id,
    chunkId: result.chunk_id,
    chunkIndex: result.chunk_index,
    text: result.text,
    score: result.score,
    explain: result._explain,
  }));
}
