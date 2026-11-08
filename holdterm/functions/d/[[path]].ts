import { proxy } from '../proxy'
export const onRequest = ({ request, params }: { request: Request; params: { path?: string[] } }) => proxy('https://copybook.factordynamics.com/d/', (params.path ?? []).join('/'), request)
