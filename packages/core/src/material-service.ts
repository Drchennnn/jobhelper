import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  IsoTimestamp,
  MaterialId,
  MaterialKind,
  MaterialRecord,
  ProfileId,
} from '@jobhelper/contracts';
import type { ProfileRepository, StorageUnitOfWork } from '@jobhelper/storage';
import { sha256Buffer } from './hash.js';

export interface MaterialStoreOptions {
  /** Root managed directory where `materials/` files are persisted. */
  rootDir: string;
  /** Maximum single material size in bytes. Defaults to 25 MiB. */
  maxFileSizeBytes?: number;
}

export interface MaterialTextSlice {
  materialId: MaterialId;
  fileName: string;
  mimeType: string;
  content: string;
  offset: number;
  nextOffset: number | null;
  totalChars: number;
}

const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024;

function sanitizeExtension(fileName: string): string {
  const ext = path.extname(path.basename(fileName)).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

function assertContainedPath(rootDir: string, relativePath: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(resolvedRoot, relativePath);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(`非法材料路径越界: ${relativePath}`);
  }
  return resolvedTarget;
}

export class LocalMaterialService {
  private readonly rootDir: string;
  private readonly maxFileSizeBytes: number;

  constructor(
    private readonly uow: StorageUnitOfWork,
    private readonly profiles: ProfileRepository,
    options: MaterialStoreOptions,
  ) {
    this.rootDir = path.resolve(options.rootDir);
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
  }

  importFromBuffer(input: {
    profileId?: ProfileId;
    kind: MaterialKind;
    fileName: string;
    mimeType: string;
    data: Buffer;
  }): MaterialRecord {
    const cleanName = path.basename(input.fileName).trim();
    if (!cleanName) {
      throw new Error('附件文件名不能为空');
    }
    if (input.data.byteLength === 0) {
      throw new Error('附件内容为空');
    }
    if (input.data.byteLength > this.maxFileSizeBytes) {
      throw new Error(
        `附件超过大小上限 (${this.maxFileSizeBytes} bytes): ${cleanName} (${input.data.byteLength} bytes)`,
      );
    }

    const id = crypto.randomUUID() as MaterialId;
    const ext = sanitizeExtension(cleanName);
    const relativePath = path.posix.join('materials', `${id}${ext}`);
    const fullPath = assertContainedPath(this.rootDir, relativePath);
    const sha256 = sha256Buffer(input.data);
    const now = new Date().toISOString() as IsoTimestamp;

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, input.data);

    const record: MaterialRecord = {
      id,
      profileId: input.profileId,
      kind: input.kind,
      fileName: cleanName,
      mimeType: input.mimeType,
      sizeBytes: input.data.byteLength,
      sha256,
      relativePath,
      createdAt: now,
    };

    try {
      this.uow.runInTransaction(() => {
        this.profiles.saveMaterial(record);
      });
    } catch (error) {
      fs.rmSync(fullPath, { force: true });
      throw error;
    }

    return record;
  }

  importFromFile(input: {
    sourceFilePath: string;
    profileId?: ProfileId;
    kind: MaterialKind;
    mimeType: string;
    displayFileName?: string;
  }): MaterialRecord {
    const stat = fs.statSync(input.sourceFilePath);
    if (!stat.isFile()) {
      throw new Error(`不是有效文件: ${input.sourceFilePath}`);
    }
    if (stat.size > this.maxFileSizeBytes) {
      throw new Error(`附件超过大小上限 (${this.maxFileSizeBytes} bytes)`);
    }
    const data = fs.readFileSync(input.sourceFilePath);
    return this.importFromBuffer({
      profileId: input.profileId,
      kind: input.kind,
      fileName: input.displayFileName ?? path.basename(input.sourceFilePath),
      mimeType: input.mimeType,
      data,
    });
  }

  listMaterials(profileId?: ProfileId): MaterialRecord[] {
    return this.profiles.listMaterials(profileId);
  }

  getMaterial(materialId: MaterialId): MaterialRecord | null {
    return this.profiles.getMaterial(materialId);
  }

  /**
   * Reads raw file bytes and verifies SHA-256 integrity against metadata before returning.
   */
  readAuthorizedBuffer(
    materialId: MaterialId,
    authorizedMaterialIds?: readonly MaterialId[],
  ): { record: MaterialRecord; buffer: Buffer } {
    if (authorizedMaterialIds && !authorizedMaterialIds.includes(materialId)) {
      throw new Error(`无权读取未授权给当前任务的附件: ${materialId}`);
    }
    const record = this.profiles.getMaterial(materialId);
    if (!record) {
      throw new Error(`附件不存在: ${materialId}`);
    }
    const fullPath = assertContainedPath(this.rootDir, record.relativePath);
    const buffer = fs.readFileSync(fullPath);
    const actualHash = sha256Buffer(buffer);
    if (actualHash !== record.sha256) {
      throw new Error(`附件完整性校验失败 (${materialId}): expected ${record.sha256}, got ${actualHash}`);
    }
    return { record, buffer };
  }

  /**
   * Controlled paginated text reader for UTF-8 text/markdown/json attachments.
   */
  readTextSlice(input: {
    materialId: MaterialId;
    authorizedMaterialIds?: readonly MaterialId[];
    offset?: number;
    limit?: number;
  }): MaterialTextSlice {
    const { record, buffer } = this.readAuthorizedBuffer(
      input.materialId,
      input.authorizedMaterialIds,
    );
    const isTextLike =
      record.mimeType.startsWith('text/') ||
      record.mimeType === 'application/json' ||
      /\.(txt|md|json|csv)$/i.test(record.fileName);
    if (!isTextLike) {
      throw new Error(
        `附件 ${record.fileName} (${record.mimeType}) 不是纯文本格式，请通过专用解析器或图像视图读取`,
      );
    }
    const fullText = buffer.toString('utf8');
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.max(1, Math.min(input.limit ?? 8000, 32000));
    const slice = fullText.slice(offset, offset + limit);
    const nextOffset = offset + slice.length < fullText.length ? offset + slice.length : null;
    return {
      materialId: record.id,
      fileName: record.fileName,
      mimeType: record.mimeType,
      content: slice,
      offset,
      nextOffset,
      totalChars: fullText.length,
    };
  }
}
