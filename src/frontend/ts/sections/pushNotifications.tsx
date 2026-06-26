import { SectionContent } from "../site/SectionContent";
import m, { Vnode } from "mithril";
import { Lang } from "../singletons/Lang";
import { BindObservable } from "../components/BindObservable";
import { Study } from "../data/study/Study";
import { DashRow } from "../components/DashRow";
import { DashElement } from "../components/DashElement";
import { SectionData } from "../site/SectionData";
import { Requests } from "../singletons/Requests";
import { FILE_ADMIN } from "../constants/urls";

interface PushInfo { vapidConfigured: boolean, subscriptions: number }

/**
 * Dedicated study-level admin panel for web push reminders: enable them, see the current
 * subscribed-device count + whether VAPID is configured on the server, and send a test push.
 */
export class Content extends SectionContent {
	private pushInfo: PushInfo | null
	private pushTestResult: string | null = null

	public static preLoad(sectionData: SectionData): Promise<any>[] {
		return [
			Requests.loadJson(`${FILE_ADMIN}?type=GetPushInfo&study_id=${sectionData.getStaticInt("id") ?? 0}`).catch(() => null),
			sectionData.getStudyPromise()
		]
	}

	constructor(sectionData: SectionData, pushInfo: PushInfo | null) {
		super(sectionData)
		this.pushInfo = pushInfo
	}

	public title(): string {
		return Lang.get("push_notifications")
	}

	private async loadPushInfo(study: Study): Promise<void> {
		this.pushInfo = await this.sectionData.loader.loadJson(`${FILE_ADMIN}?type=GetPushInfo&study_id=${study.id.get()}`)
		m.redraw()
	}

	private async sendTestPush(study: Study): Promise<void> {
		const r = await this.sectionData.loader.loadJson(`${FILE_ADMIN}?type=SendTestPush&study_id=${study.id.get()}`, "post")
		this.pushTestResult = `${r.succeeded ?? 0} / ${r.queued ?? 0} delivered`
		await this.loadPushInfo(study)
	}

	public getView(): Vnode<any, any> {
		const study = this.getStudyOrThrow()
		return <div>
			{DashRow(
				DashElement("stretched", {
					content:
						<div class="vAlignCenter">
							<label class="noTitle noDesc">
								<input type="checkbox" {...BindObservable(study.webPushEnabled)} />
								<span>{Lang.get('enable_web_push')}</span>
								<small>{Lang.get('enable_web_push_info')}</small>
							</label>
						</div>
				})
			)}

			{study.webPushEnabled.get() && DashRow(
				DashElement("stretched", {
					content:
						<div class="vertical hAlignStart">
							<label class="noTitle"><span>{Lang.getWithColon("web_push_subscriptions")}</span></label>
							<div class="vAlignCenter">
								<span class="spacingRight">{this.pushInfo ? this.pushInfo.subscriptions : "—"}</span>
								<button type="button" onclick={() => this.loadPushInfo(study)}>{Lang.get("web_push_status")}</button>
							</div>
							{this.pushInfo && !this.pushInfo.vapidConfigured && <small>{Lang.get("web_push_no_vapid")}</small>}
						</div>
				}),
				DashElement("stretched", {
					content:
						<div class="vertical hAlignStart">
							<label class="noTitle"><span>{Lang.getWithColon("send_test_notification")}</span></label>
							<button type="button" onclick={() => this.sendTestPush(study)}>{Lang.get("send_test_notification")}</button>
							{this.pushTestResult && <small>&nbsp;{this.pushTestResult}</small>}
						</div>
				})
			)}
		</div>
	}
}
