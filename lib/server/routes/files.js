import { listDirectory } from '../../browse.js';
import { isWithin } from '../../paths.js';
import { pickFolderNative } from '../../native-dialog.js';
import { buildPreview, parseRelativePath, scanFolder } from '../../renamer.js';
import { forbidden } from '../root-policy.js';

/** Browsing folders, scanning them and previewing new names. Nothing here changes files. */
export function fileRoutes({ policy, currentSettings, filtersFrom, localeFrom, allowedRoot, previewTargets, metadataFor }) {
  return {
    async '/api/browse'(body) {
      const { real, root } = await policy.check(body.path);
      const listing = await listDirectory(real, { showHidden: body.showHidden === true });
      if (!root) return listing;
      return {
        ...listing,
        parent: listing.path === root ? null : listing.parent,
        breadcrumbs: listing.breadcrumbs.filter((crumb) => isWithin(root, crumb.path)),
      };
    },

    async '/api/pick-folder'(body) {
      if (policy.restricted) throw forbidden('The system folder dialog is disabled when MEDIA_RENAMER_ROOTS is set');
      return pickFolderNative({ start: body.start });
    },

    async '/api/scan'(body) {
      const root = await allowedRoot(body.root);
      const { effective } = await currentSettings();
      const filters = filtersFrom(body, effective);
      const { files, truncated, excluded } = await scanFolder(root, { recursive: body.recursive !== false, ...filters });
      return { root, truncated, excluded, filters, files: files.map((rel) => ({ rel, parsed: parseRelativePath(rel) })) };
    },

    async '/api/preview'(body) {
      const root = await allowedRoot(body.root);
      const { effective } = await currentSettings();
      const targets = await previewTargets(root, body, effective);
      const { language, region } = localeFrom(body, effective);
      const patterns = { ...effective.patterns, ...body.patterns };
      const metadata = metadataFor({ language, region });
      const items = await buildPreview({ root, targets, files: body.files, patterns, filters: filtersFrom(body, effective), metadata });
      return { root, targets, language, region, patterns, items };
    },
  };
}
