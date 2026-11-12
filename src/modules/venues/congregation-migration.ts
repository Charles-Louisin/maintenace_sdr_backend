import { Types } from 'mongoose';
import { Venue, ResponsibleContact } from '../../models/registry.js';
import { WorkEvent } from '../../models/work.js';
import { isGroupCongregation } from '../extraction/normalize.js';
import { logger } from '../../lib/logger.js';

export const ALL_CONGREGATIONS = 'Toutes les assemblées';

/**
 * « Toutes les assemblées » n'est plus une assemblée enregistrée dans la salle :
 * - une intervention commune à toute la salle a congregationId = null ;
 * - un responsable de toute la salle a la salle dans venueIds (sinon : ses assemblées dans congregationIds).
 * Migration idempotente, exécutée au démarrage du serveur.
 */
export async function migrateGroupCongregations(): Promise<number> {
  let changed = 0;
  const venues = await Venue.find({});
  for (const venue of venues) {
    const groups = venue.congregations.filter((c) => c.isGroup || isGroupCongregation(c.name));
    const groupIds = groups.map((g) => g._id);
    if (groupIds.length) {
      await WorkEvent.updateMany({ venueId: venue._id, congregationId: { $in: groupIds } }, { $set: { congregationId: null, congregationName: ALL_CONGREGATIONS } });
      // Responsables des pseudo-assemblées : responsables de toute la salle
      await ResponsibleContact.updateMany(
        { congregationIds: { $in: groupIds } },
        { $pull: { congregationIds: { $in: groupIds } }, $addToSet: { venueIds: venue._id } },
      );
      for (const g of groups) if (g.coordinatorId) await ResponsibleContact.updateOne({ _id: g.coordinatorId }, { $addToSet: { venueIds: venue._id } });
      venue.set(
        'congregations',
        venue.congregations.filter((c) => !groupIds.some((id) => String(id) === String(c._id))),
      );
      await venue.save();
      changed += groupIds.length;
    }
  }

  // Anciennes fiches : la salle était ajoutée à chaque responsable, même rattaché à une seule assemblée.
  // On ne garde « toute la salle » que si aucune assemblée précise de cette salle n'est indiquée.
  const congToVenue = new Map<string, string>();
  for (const v of await Venue.find({}).select('congregations').lean()) for (const c of v.congregations) congToVenue.set(String(c._id), String(v._id));
  const contacts = await ResponsibleContact.find({ venueIds: { $exists: true, $ne: [] }, congregationIds: { $exists: true, $ne: [] } });
  for (const c of contacts) {
    const specific = new Set(c.congregationIds.map((id) => congToVenue.get(String(id))).filter(Boolean));
    const keep = c.venueIds.filter((v) => !specific.has(String(v)));
    if (keep.length !== c.venueIds.length) {
      c.set('venueIds', keep as Types.ObjectId[]);
      await c.save();
      changed++;
    }
  }
  if (changed) logger.info({ changed }, 'Assemblées « toutes » converties en responsabilité de salle');
  return changed;
}
