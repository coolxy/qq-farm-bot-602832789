import type { Request } from 'express';
import type { ActivityRouteContext } from './types';

export function mountSweetPotatoActivityRoutes({ app, ctx, withAccount, mountGet }: ActivityRouteContext): void {
    mountGet('/api/activity-center/sweet-potato', 'getSweetPotatoActivity');
    mountGet('/api/activity-center/sweet-potato/shop-catalog', 'getSweetPotatoShopCatalog');
    app.get('/api/activity-center/sweet-potato/shops', withAccount((accountId, req: Request) => (
        ctx.provider.getSweetPotatoShops(accountId, { offset: req.query?.offset })
    )));
    mountGet('/api/activity-center/sweet-potato/records', 'getSweetPotatoRecords');
    app.get('/api/activity-center/sweet-potato/scan', withAccount((accountId, req: Request) => (
        ctx.provider.scanSweetPotatoShops(accountId, { limit: req.query?.limit })
    )));
    app.post('/api/activity-center/sweet-potato/:action', withAccount((accountId, req: Request) => (
        ctx.provider.operateSweetPotato(accountId, req.params.action, req.body || {})
    )));
}
