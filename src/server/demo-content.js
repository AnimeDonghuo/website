const daysAgo = (days, hour = 18) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};

// These are original placeholder records used only when MongoDB is not configured.
// Real records are created by the Telegram publisher flow and persist in MongoDB.
export const demoContent = [
  {
    id: 'demo-neon-runners',
    shareCode: 'demoNeon01',
    slug: 'neon-runners',
    title: 'Neon Runners',
    category: 'anime',
    year: 2026,
    languages: ['Japanese', 'English Sub'],
    genres: ['Action', 'Sci-Fi'],
    description: 'In a sleepless city built on light, two rookie couriers race through impossible skylines to keep one message out of the wrong hands.',
    status: 'New season',
    releaseLabel: 'Season 1',
    filesCount: 12,
    featured: true,
    art: { tone: 'violet', mark: 'NR', motif: 'orbital' },
    publishedAt: daysAgo(0, 12)
  },
  {
    id: 'demo-moonlit-archive',
    shareCode: 'demoMoon02',
    slug: 'moonlit-archive',
    title: 'The Moonlit Archive',
    category: 'kdrama',
    year: 2026,
    languages: ['Korean', 'English Sub'],
    genres: ['Mystery', 'Romance'],
    description: 'A meticulous archivist and an impulsive reporter uncover a secret that has been hidden between the pages of a royal collection.',
    status: 'Complete',
    releaseLabel: '16 episodes',
    filesCount: 16,
    art: { tone: 'rose', mark: 'MA', motif: 'lunar' },
    publishedAt: daysAgo(1)
  },
  {
    id: 'demo-pocket-planet',
    shareCode: 'demoPocket03',
    slug: 'pocket-planet',
    title: 'Pocket Planet',
    category: 'cartoon',
    year: 2026,
    languages: ['Hindi', 'English'],
    genres: ['Family', 'Adventure'],
    description: 'Three tiny explorers discover that the big world in their backyard has its own weather, wildlife and wildly silly rules.',
    status: 'Fresh drop',
    releaseLabel: 'Specials',
    filesCount: 4,
    art: { tone: 'orange', mark: 'PP', motif: 'planet' },
    publishedAt: daysAgo(2)
  },
  {
    id: 'demo-red-sand',
    shareCode: 'demoSand04',
    slug: 'red-sand-signal',
    title: 'Red Sand Signal',
    category: 'movie',
    year: 2025,
    languages: ['Hindi', 'English'],
    genres: ['Thriller', 'Adventure'],
    description: 'A stranded radio operator picks up a distress signal from an expedition that vanished in the desert twenty years ago.',
    status: 'Feature film',
    releaseLabel: '2h 04m',
    filesCount: 1,
    art: { tone: 'lime', mark: 'RS', motif: 'dune' },
    publishedAt: daysAgo(3)
  },
  {
    id: 'demo-jade-circuit',
    shareCode: 'demoJade05',
    slug: 'jade-circuit',
    title: 'Jade Circuit',
    category: 'donghua',
    year: 2026,
    languages: ['Chinese', 'English Sub'],
    genres: ['Fantasy', 'Martial Arts'],
    description: 'A gifted apprentice follows a living map through floating provinces in search of the only forge that can repair a broken sky.',
    status: 'Ongoing',
    releaseLabel: 'Episode 24',
    filesCount: 24,
    episodeCount: 24,
    episodeGroups: [
      { start: 1, end: 6, label: 'Episodes 01–06', fileCount: 1 },
      { start: 7, end: 12, label: 'Episodes 07–12', fileCount: 1 },
      { start: 13, end: 18, label: 'Episodes 13–18', fileCount: 1 },
      { start: 19, end: 24, label: 'Episodes 19–24', fileCount: 1 }
    ],
    art: { tone: 'cyan', mark: 'JC', motif: 'jade' },
    publishedAt: daysAgo(4)
  },
  {
    id: 'demo-ghost-protocol',
    shareCode: 'demoGhost06',
    slug: 'ghost-protocol',
    title: 'Ghost Protocol 9',
    category: 'web-series',
    year: 2026,
    languages: ['English', 'Hindi'],
    genres: ['Crime', 'Drama'],
    description: 'A suspended analyst receives encrypted cases from a caller who appears to know every move the department will make.',
    status: 'New episodes',
    releaseLabel: 'Episode 08',
    filesCount: 8,
    art: { tone: 'blue', mark: 'GP', motif: 'signal' },
    publishedAt: daysAgo(5)
  },
  {
    id: 'demo-tidekeepers',
    shareCode: 'demoTide07',
    slug: 'tidekeepers',
    title: 'Tidekeepers',
    category: 'anime',
    year: 2025,
    languages: ['Japanese', 'Hindi'],
    genres: ['Fantasy', 'Drama'],
    description: 'A quiet apprentice learns that every tide has a memory, and some memories are powerful enough to flood an entire kingdom.',
    status: 'Complete',
    releaseLabel: '24 episodes',
    filesCount: 24,
    art: { tone: 'violet', mark: 'TK', motif: 'wave' },
    publishedAt: daysAgo(7)
  },
  {
    id: 'demo-paper-comet',
    shareCode: 'demoComet08',
    slug: 'paper-comet-club',
    title: 'Paper Comet Club',
    category: 'cartoon',
    year: 2025,
    languages: ['English'],
    genres: ['Comedy', 'Family'],
    description: 'A school club accidentally sends its papier-mâché comet into orbit, then has to bring it home before the science fair.',
    status: 'Complete',
    releaseLabel: '10 episodes',
    filesCount: 10,
    art: { tone: 'orange', mark: 'PC', motif: 'comet' },
    publishedAt: daysAgo(8)
  }
];
