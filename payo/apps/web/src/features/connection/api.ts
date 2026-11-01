import {
	DoctorReport,
	type DoctorReport as DoctorReportData,
} from "@payo/contracts";
import { getJson } from "@web/shared/api/client.ts";

export async function getDoctor(token: string): Promise<DoctorReportData> {
	return getJson("/doctor", token, "GET", (data) => DoctorReport.parse(data));
}
