import http from '@/axios/index.js';

export function allEmailList(params) {
    const includeTotal = params.full ? 0 : 1;
    return http.get('/allEmail/list', {params: {...params, includeTotal}})
}

export function allEmailDelete(emailIds) {
    return http.delete('/allEmail/delete?emailIds=' + emailIds)
}

export function allEmailBatchDelete(params) {
    return http.delete('/allEmail/batchDelete', {params: params} )
}

export function allEmailLatest(emailId) {
    return http.get('/allEmail/latest', {params: {emailId}, noMsg: true, timeout: 35 * 1000})
}
