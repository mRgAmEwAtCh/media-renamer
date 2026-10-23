import { listDirectory } from '../../browse.ts';
import { isWithin } from '../../paths.ts';
import { pickFolderNative } from '../../native-dialog.ts';
import { buildPreview, freeName, parseRelativePath, scanFolder } from '../../renamer.ts';
import type { Patterns } from '../../types.ts';
import type { ApiResponse } from '../../api-types.ts';
import type { RouteContext } from '../context.ts';
import type { RequestBody, Routes } from '../http.ts';
import { forbidden } from '../root-policy.ts';

/** Browsing folders, scanning them and previewing new names. Nothing here changes files. */
export function fileRoutes({ policy, currentSettings, filtersFrom, localeFrom, allowedRoot, allowedTarget, previewTargets, metadataFor }: RouteContext): Routes {
  return {
    async '/api/browse'(body: RequestBody): Promise<ApiResponse<'/api/browse'>> {
      const { real, root } = await policy.check(body.path);
      const listing = await listDirectory(real, { showHidden: body.showHidden === true });
      if (!root) return listing;
      return {
        ...listing,
        parent: listing.path === root ? null : listing.parent,
        breadcrumbs: listing.breadcrumbs.filter((crumb) => isWithin(root, crumb.path)),
      };
    },

    async '/api/pick-folder'(body: RequestBody): Promise<ApiResponse<'/api/pick-folder'>> {
      if (policy.restricted) throw forbidden('The system folder dialog is disabled when MEDIA_RENAMER_ROOTS is set');
      return pickFolderNative({ start: body.start });
    },

    async '/api/scan'(body: RequestBody): Promise<ApiResponse<'/api/scan'>> {
      const root = await allowedRoot(body.root);
      const { effective } = await currentSettings();
      const filters = filtersFrom(body, effective);
      const { files, truncated, excluded } = await scanFolder(root, { recursive: body.recursive !== false, ...filters });
      return { root, truncated, excluded, filters, files: files.map((rel) => ({ rel, parsed: parseRelativePath(rel) })) };
    },

    async '/api/free-name'(body: RequestBody): Promise<ApiResponse<'/api/free-name'>> {
      const root = await allowedRoot(body.root);
      const destination = (await allowedTarget(root, body.target)) ?? root;
      const taken = Array.isArray(body.taken) ? body.taken.map(String) : [];
      return { newRel: await freeName(destination, String(body.rel ?? ''), taken) };
    },

    async '/api/preview'(body: RequestBody): Promise<ApiResponse<'/api/preview'>> {
      const root = await allowedRoot(body.root);
      const { effective } = await currentSettings();
      const targets = await previewTargets(root, body, effective);
      const { language, region } = localeFrom(body, effective);
      const patterns = { ...effective.patterns, ...(body.patterns as Partial<Patterns> | undefined) };
      const metadata = metadataFor({ language, region });
      const items = await buildPreview({ root, targets, files: body.files as string[], patterns, filters: filtersFrom(body, effective), metadata });
      return { root, targets, language, region, patterns, items };
    },
  };
}
