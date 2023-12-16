import { ISystemConfigRepository } from '@app/domain';
import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { databaseConfig } from '../database.config';
import { databaseEntities } from '../entities';
import { GENERATE_SQL_KEY, GenerateSqlQueries } from '../infra.util';
import {
  AccessRepository,
  AlbumRepository,
  ApiKeyRepository,
  AssetRepository,
  AuditRepository,
  LibraryRepository,
  MoveRepository,
  PartnerRepository,
  PersonRepository,
  SharedLinkRepository,
  SmartInfoRepository,
  SystemConfigRepository,
  SystemMetadataRepository,
  TagRepository,
  UserRepository,
  UserTokenRepository,
} from '../repositories';
import { SqlLogger } from './sql.logger';

const reflector = new Reflector();
const repositories = [
  AccessRepository,
  AlbumRepository,
  ApiKeyRepository,
  AssetRepository,
  AuditRepository,
  LibraryRepository,
  MoveRepository,
  PartnerRepository,
  PersonRepository,
  SharedLinkRepository,
  SmartInfoRepository,
  SystemConfigRepository,
  SystemMetadataRepository,
  TagRepository,
  UserTokenRepository,
  UserRepository,
];

type Repository = (typeof repositories)[0];
type SqlGeneratorOptions = { targetDir: string };

class SqlGenerator {
  private app: INestApplication | null = null;
  private sqlLogger = new SqlLogger();
  private results: Record<string, string[]> = {};

  constructor(private options: SqlGeneratorOptions) {}

  async run() {
    try {
      await this.setup();
      for (const Repository of repositories) {
        await this.process(Repository);
      }
      await this.write();
      this.stats();
    } finally {
      await this.close();
    }
  }

  private async setup() {
    await rm(this.options.targetDir, { force: true, recursive: true });
    await mkdir(this.options.targetDir);

    const moduleFixture = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          ...databaseConfig,
          entities: databaseEntities,
          logging: ['query'],
          logger: this.sqlLogger,
        }),
        TypeOrmModule.forFeature(databaseEntities),
      ],
      providers: [{ provide: ISystemConfigRepository, useClass: SystemConfigRepository }, ...repositories],
    }).compile();

    this.app = await moduleFixture.createNestApplication().init();
  }

  async process(Repository: Repository) {
    if (!this.app) {
      throw new Error('Not initialized');
    }

    const data: string[] = [`-- NOTE: This file is auto generated by ./sql-generator`];
    const instance = this.app.get<Repository>(Repository);
    const properties = Object.getOwnPropertyNames(Repository.prototype) as Array<keyof typeof Repository>;
    for (const key of properties) {
      const target = instance[key];
      if (!(target instanceof Function)) {
        continue;
      }

      const queries = reflector.get<GenerateSqlQueries[] | undefined>(GENERATE_SQL_KEY, target);
      if (!queries) {
        continue;
      }

      // empty decorator implies calling with no arguments
      if (queries.length === 0) {
        queries.push({ params: [] });
      }

      for (const { name, params } of queries) {
        let queryLabel = `${Repository.name}.${key}`;
        if (name) {
          queryLabel += ` (${name})`;
        }

        this.sqlLogger.clear();

        // errors still generate sql, which is all we care about
        await target.apply(instance, params).catch(() => null);

        if (this.sqlLogger.queries.length === 0) {
          console.warn(`No queries recorded for ${queryLabel}`);
          continue;
        }

        data.push([`-- ${queryLabel}`, ...this.sqlLogger.queries].join('\n'));
      }
    }

    this.results[Repository.name] = data;
  }

  private async write() {
    for (const [repoName, data] of Object.entries(this.results)) {
      const filename = repoName.replace(/[A-Z]/g, (letter) => `.${letter.toLowerCase()}`).replace('.', '');
      const file = join(this.options.targetDir, `${filename}.sql`);
      await writeFile(file, data.join('\n\n') + '\n');
    }
  }

  private stats() {
    console.log(`Wrote ${Object.keys(this.results).length} files`);
    console.log(`Generated ${Object.values(this.results).flat().length} queries`);
  }

  private async close() {
    if (this.app) {
      await this.app.close();
    }
  }
}

new SqlGenerator({ targetDir: './src/infra/sql' })
  .run()
  .then(() => {
    console.log('Done');
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    console.log('Something went wrong');
    process.exit(1);
  });
