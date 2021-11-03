import { Main } from "../Main";
import { BotCommand, BotCommandHandler, CommandArguments, Logging } from "matrix-appservice-bridge";
import { UsersInfoResponse } from "../SlackResponses";
import { createDM } from "../RoomCreation";
import { promises as fs } from "fs";
import * as path from "path";

const log = Logging.get("UserAdminRoom");

const onboardingTemplatePath = path.resolve(path.join(__dirname, "../.." , "templates/onboarding"));

export class UserAdminRoom {
    handler: BotCommandHandler<this, null>;

    public static IsAdminRoomInvite(event: {content?: Record<string, unknown>, state_key?: string}, botId: string): boolean {
        return (event.content?.membership === "invite" &&
                event.state_key === botId &&
                event.content?.is_direct === true);
    }

    private static onboardingHtml: string;
    private static onboardingPlain: string;

    public static async compileTemplates() {
        UserAdminRoom.onboardingPlain = await fs.readFile(onboardingTemplatePath + ".txt", "utf-8");
        UserAdminRoom.onboardingHtml = await fs.readFile(onboardingTemplatePath + ".html", "utf-8");
    }

    public static async inviteAndCreateAdminRoom(userId: string, main: Main) {
        const roomId = await createDM(main.botIntent, userId);
        await main.datastore.setUserAdminRoom(userId, roomId);
        const adminRoom = new UserAdminRoom(roomId, userId, main);
        await adminRoom.sendOnboardingMessage();
        return adminRoom;
    }

    constructor(private roomId: string, private userId: string, private main: Main) {
        this.handler = new BotCommandHandler(this);
    }

    public async handleEvent(ev: {type: string, content: {msgtype: string, body: string}}): Promise<unknown> {
        if (ev.type !== "m.room.message" || ev.content.msgtype !== "m.text" || !ev.content.body) {
            return;
        }
        const input = ev.content.body;
        log.info(`${this.userId} sent admin message ${input.split(' ')[0].substr(32)}`);
        (await this.handler.handleCommand(input, null)) || this.sendNotice("Command not understood");
    }

    @BotCommand({ name: 'login', help: 'Log into a Slack account' })
    public async handleLogin(): Promise<void> {
        if (!this.main.oauth2 || !this.main.config.puppeting?.enabled) {
            await this.sendNotice("This bridge is not configured to allow logging into Slack accounts.");
            return;
        }
        const token = this.main.oauth2.getPreauthToken(this.userId);
        const authUri = this.main.oauth2.makeAuthorizeURL(
            token,
            token,
            true,
        );
        await this.sendNotice(
            `Follow ${authUri} to connect your account.`,
            `Follow <a href="${authUri}">this link</a> to connect your account.`,
        );
    }

    @BotCommand({ name: 'logout', help: 'Log out of your Slack account', optionalArgs: ['account-id'] })
    public async handleLogout(data: CommandArguments<never>) {
        let accountId = data.args[1];
        const puppets = await this.main.datastore.getPuppetsByMatrixId(this.userId);
        if (puppets.length === 0) {
            return this.sendNotice("You are not logged into any accounts.");
        } else if (puppets.length > 1 && !accountId) {
            await this.sendNotice(
                "You are connected to multiple accounts. Please choose one and then say `logout $accountId`"
            );
            let body = "List of connected accounts:\n";
            let formattedBody = "<p>List of connected accounts:</p><ul>";
            for (const puppet of puppets) {
                const team = await this.main.datastore.getTeam(puppet.teamId);
                body += `\n - ${puppet.slackId} for ${team?.name || puppet.teamId}`;
                formattedBody += `<li>${puppet.slackId} for ${team?.name || puppet.teamId}</li>`;
            }
            formattedBody += "</ul>";
            return this.sendNotice(body, formattedBody);
        } else if (!accountId) {
            // Default to the first
            accountId = puppets[0].slackId;
        }
        const result = await this.main.logoutAccount(this.userId, accountId.trim());
        if (result.deleted) {
            return this.sendNotice("You have been logged out.");
        }
        return this.sendNotice(`Could not log out of your account: ${result.msg}`);
    }

    @BotCommand({ name: 'whoami', help: 'Lists Slack accounts you are be logged in as' })
    public async handleWhoAmI(): Promise<unknown> {
        const puppets = await this.main.datastore.getPuppetsByMatrixId(this.userId);
        if (puppets.length === 0) {
            return this.sendNotice("You are not logged into Slack. You may talk in public rooms only.");
        }
        let body = "List of connected accounts:\n";
        let formattedBody = "<p>List of connected accounts:</p><ul>";
        for (const puppet of puppets) {
            const cli = await this.main.clientFactory.getClientForUser(puppet.teamId, puppet.matrixId);
            const team = await this.main.datastore.getTeam(puppet.teamId);
            if (!team) {
                log.warn(
                    `Failed to fetch team ${puppet.teamId} for the connected account ${puppet.matrixId}. ` +
                    'The datastore changed recently or is inconsistent.'
                );
            }
            if (cli === null) {
                continue;
            }
            const { user } = await cli.users.info({user: puppet.slackId}) as UsersInfoResponse;
            if (user === undefined) {
                continue;
            }
            body += `You are logged in as ${user.name} (${team?.name || puppet.teamId})\n`;
            formattedBody += `<li>You are logged in as <strong>${user.name}</strong> (${team!.name || puppet.teamId}) </li>`;
        }
        formattedBody += "</ul>";
        return this.sendNotice(body, formattedBody);
    }

    @BotCommand({ name: 'help', help: 'Shows you this help text' })
    public async handleHelp() {
        return this.sendNotice(this.handler.helpMessage.body, this.handler.helpMessage.formatted_body);
    }

    public async sendOnboardingMessage() {
        return this.main.botIntent.sendMessage(this.roomId, {
            msgtype: "m.notice",
            body: UserAdminRoom.onboardingPlain,
            formatted_body: UserAdminRoom.onboardingHtml,
            format: "org.matrix.custom.html",
        });
    }

    private async sendNotice(body: string, formattedBody?: string) {
        return this.main.botIntent.sendMessage(this.roomId, {
            msgtype: "m.notice",
            body,
            formatted_body: formattedBody,
            format: formattedBody ? "org.matrix.custom.html" : undefined,
        });
    }
}
