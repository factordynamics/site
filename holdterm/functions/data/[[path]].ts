import { proxy } from '../proxy'
export const onRequest = ({ request, params }: { request: Request; params: { path?: string[] } }) => proxy('https://refcell.github.io/gust/copybook/data/', (params.path ?? []).join('/'), request)
