/** The generated corpus shared by the SQL micro-budget and the later read-heavy load scenario. */
export const SEARCH_CORPUS_SIZE = 5_000;

const TOPICS = [
  ['astronomy', 'quasar orbit telescope observation galaxy spectrum'],
  ['gardening', 'orchard harvest compost soil pruning seedlings'],
  ['software', 'release checklist migration database deployment rollback'],
  ['cooking', 'sourdough recipe fermentation kitchen flour starter'],
  ['cycling', 'bicycle route climbing cadence training recovery'],
  ['music', 'piano rehearsal harmony composition melody rhythm'],
  ['geology', 'basalt granite sediment mineral erosion landscape'],
  ['photography', 'camera exposure aperture portrait lighting lens'],
  ['history', 'archive manuscript chronology museum settlement evidence'],
  ['woodwork', 'timber dovetail workshop chisel grain cabinet'],
] as const;

const COMMON = [
  'The team recorded the observations and reviewed the next steps for the project.',
  'These notes explain the current approach, the supporting evidence and the open questions.',
  'We compared the previous result with the new measurements before updating the plan.',
  'The review includes practical examples, a short checklist and references for later work.',
];

export interface SearchCorpusNote {
  readonly name: string;
  readonly markdown: string;
  readonly topic: string;
}

/** Unequal document lengths, repeated common words and selective terms give FULLTEXT real work. */
export function generateSearchCorpus(): readonly SearchCorpusNote[] {
  return Array.from({ length: SEARCH_CORPUS_SIZE }, (_, index) => {
    const topic = TOPICS[index % TOPICS.length];
    if (topic === undefined) throw new Error('Every corpus index has a topic.');
    const [name, vocabulary] = topic;
    const title = `${name} field notes ${String(index).padStart(4, '0')}`;
    const paragraphs = Array.from({ length: 4 + index % 9 }, (_, paragraph) =>
      `${COMMON[(index + paragraph) % COMMON.length]} ${paragraph % 3 === 0 ? vocabulary + '.' : ''}`,
    );
    return { name: title, topic: name, markdown: `# ${title}\n\n${paragraphs.join('\n\n')}\n\n- [ ] Review the findings\n- [x] Record the source\n` };
  });
}

/** These queries exercise ordinary terms, a phrase and a short title token over the same corpus. */
export const SEARCH_CORPUS_QUERIES = ['quasar', '"release checklist"', 'orchard harvest', 'piano', 'a'] as const;
