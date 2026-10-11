import app from './hono/webs';
import { email } from './email/email';
import userService from './service/user-service';
import verifyRecordService from './service/verify-record-service';
import emailService from './service/email-service';
import kvObjService from './service/kv-obj-service';
import oauthService from './service/oauth-service';
import analysisService from './service/analysis-service';
export default {
	 async fetch(req, env, ctx) {

		const url = new URL(req.url)

		if (url.pathname.startsWith('/api/')) {
			url.pathname = url.pathname.replace('/api', '')
			req = new Request(url.toString(), req)
			return app.fetch(req, env, ctx);
		}

		 if (['/static/','/attachments/'].some(p => url.pathname.startsWith(p))) {
			 return await kvObjService.toObjResp( { env }, url.pathname.substring(1));
		 }

		const assetFetch = env.assets?.fetch;
		if (typeof assetFetch !== 'function') {
			return new Response('Static assets binding is not configured', { status: 503 });
		}

		return assetFetch.call(env.assets, req);
	},
	email: email,
	async scheduled(c, env, ctx) {
		const minute = new Date(c.scheduledTime).getUTCMinutes();
		const isHourly = minute === 0;
		const isAnalysisRun = minute % 30 === 0;

		if (isHourly) {
			await verifyRecordService.clearRecord({ env });
			await userService.resetDaySendCount({ env });
			await emailService.completeReceiveAll({ env });
		}

		await emailService.autoClean({ env });

		if (isAnalysisRun) {
			await analysisService.refreshEchartsCache({ env });
		}

		if (isHourly) {
			await oauthService.clearNoBindOathUser({ env });
		}
	},
};
