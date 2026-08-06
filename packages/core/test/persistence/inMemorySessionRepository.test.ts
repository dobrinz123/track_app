import { InMemorySessionRepository } from '../../src/persistence';
import { runRepositoryContractTests } from './contractSuite';

// Every assertion below now lives in `runRepositoryContractTests` (see
// contractSuite.ts) so it runs, unmodified, against both
// InMemorySessionRepository and SqlSessionRepository(sql.js) -- see
// test/persistence-sql/sqlSessionRepository.contract.test.ts.
runRepositoryContractTests('InMemorySessionRepository', async () => new InMemorySessionRepository());
