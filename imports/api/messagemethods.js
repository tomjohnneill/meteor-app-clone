import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { check } from 'meteor/check';
import { Messages, Conversations } from '/imports/api/messages.js';
import { Pledges } from '/imports/api/pledges.js';
import { ValidatedMethod } from 'meteor/mdg:validated-method';
import {SimpleSchema} from 'meteor/aldeed:simple-schema';
import {callSendAPI} from '/imports/api/alertmethods.js';

if (Meteor.isServer) {
  Messages._ensureIndex({ type: 1, approved: 1 }, { unique: false });
  Messages._ensureIndex({ receiver: 1, approved: 1 }, { unique: false });
  Messages._ensureIndex({ sender: 1, approved: 1 }, { unique: false });
  Messages._ensureIndex({ pledgeId: 1 }, { unique: false });
  Conversations._ensureIndex({ members: 1 }, { unique: false });


  Meteor.publish("newBroadcastMessages", function(){
    return Messages.find({type: 'broadcast', approved: false})
  });

  Meteor.publish("myMessages", function() {
    return Messages.find({$or: [{receiver: this.userId, approved: true}, {sender: this.userId, approved: true}]})
  })

  Meteor.publish("myConversations", function() {
    return Conversations.find({members: this.userId})
  })

  Meteor.publish("messagePledges", function() {
    return Messages.distinct("pledgeId", {
      $or: [{receiver: this.userId, approved: true}, {sender: this.userId, approved: true}]
    })
  });

  Meteor.publish("conversationUsers", function(id) {

    var conversation = Conversations.findOne({_id: id})
    if (conversation) {
    return Meteor.users.find({_id: {$in : conversation.members}}, {
      fields: {_id: 1, 'geo.country': 1, roles: 1, 'profile.name': 1, 'profile.picture': 1}
    })
    }
    else {
      return []
    }
  })


}



Meteor.methods({
  returnConversations: function() {
    console.log( Messages.aggregate(
      {
        $match : {
          $or: [{receiver: this.userId, approved: true}
            , {sender: this.userId, approved: true}]
        }
      },

      {
        $project:{
          user:
            {$cond: {
             if: { $ne : ["$sender", this.userId],
             then: "$sender",
             else: "$receiver"
              }
            }
          },
          type: 1
      }
    },

      {
        $group : {
          _id:{_id:"$user"},
      }
    }
    )
  )
}

})

Meteor.publish('allUnreadMessages', function() {
  var userId = this.userId
  if (this.userId) {
    Counts.publish(this, 'theseUnreadMessages', Messages.find({
      seen: {$ne: userId}, receiver: userId
    })
  )
} else {
  this.ready()
}


  })

Meteor.publish('unreadMessages', function() {
  var conversations = Conversations.find({members: this.userId}).fetch()
  var userId = this.userId
  console.log(conversations)
  for (var i = 0; i<conversations.length; i++) {
    console.log(i)
    var id = conversations[i]._id
    console.log(id)
    Counts.publish(this, id, Messages.find({
      conversationId: id,
      seen: {$ne: userId}
    }))
  }

  })

Meteor.methods({
  seenMessage: function(id) {
    Messages.update({conversationId: id, seen: {$ne: this.userId}},
      {$push : {
      seen: this.userId
    }}, {multi: true}
  )
  }
})

Meteor.methods({
  sendBroadcastMessage: function(groupName, pledgeId, messenger, push, email, sms, text, image, conversationType) {
    if (Roles.userIsInRole(this.userId, 'admin', pledgeId)) {

      console.log(groupName)
      console.log(conversationType)
      var userIds = []
      var avatars = []
      var userCursor
      var filter = []
      var autoApprove = false

      if (!messenger && !push && !sms && !email) {
        autoApprove = true
        filter.push( {_id: 'nooneishere'})
      }

      var methods = []
      if (messenger) {
        methods.push('messenger')
        filter.push({userMessengerId: {$exists: true}})
      }
      if (push) {
        methods.push('push')
        filter.push( {oneSignalUserId: {$exists: true}})
      }
      if (sms) {
        methods.push('sms')
        filter.push({'profile.phone':{$exists: true}})
      }
      if (email) {
        methods.push('email')
        filter.push({'profile.email':{$exists: true}})
      }
      console.log(filter)

      if (groupName === 'everyone') {
        var rawIds = Pledges.findOne({_id: pledgeId}).pledgedUsers
        filter.push({_id: {$in : rawIds}})
        console.log(filter)
        userCursor = Meteor.users.find({$or: filter}, {fields: {_id: 1, userMessengerId: 1, profile: 1, oneSignalUserId: 1}}).fetch()
        for (var i in userCursor) {
          userIds.push(userCursor[i]._id)
          avatars.push({[userCursor[i]._id]: userCursor[i].profile.picture})
        }
      } else {
        var rawCursor = Roles.getUsersInRole ( groupName, pledgeId, {fields: {_id: 1}}).fetch()
        console.log(rawCursor)
        userCursor = Meteor.users.find({$or: filter, _id: {$in: rawCursor}}).fetch()
        for (var i in userCursor) {
          userIds.push(userCursor[i]._id)
          avatars.push({[userCursor[i]._id]: userCursor[i].profile.picture})
        }
      }

      console.log(userIds)
      var members = userIds
      if (!members.includes(this.userId)) {
        members.push(this.userId)
        avatars.push({[this.userId]: Meteor.user().profile.picture})
      }
      console.log(members)

      Conversations.upsert({
        pledgeId: pledgeId, group: groupName, type: conversationType
      }, {$set: {
        members: members, pledgeId: pledgeId, group: groupName, type: conversationType,
        avatars:avatars
      }
    }, (err, result) => {
        if (err) {
          console.log(err)
        } else {
          var conversationId = Conversations.findOne({pledgeId: pledgeId, group: groupName, type: conversationType})._id
          Conversations.update({_id: conversationId}, {$set: {lastMessage: new Date()}})
          Messages.insert({
            pledgeId: pledgeId,
            conversationId: conversationId,
            sender: this.userId,
            receiver: userIds,
            type: 'broadcast',
            text: text,
            image: image,
            method: methods,
            time: new Date(),
            approved: autoApprove,
            rejected: false,
            group: groupName,
            seen: [this.userId]
          })
        }
      })



  }
  }
})

Meteor.methods({
  approveMessage: function(ids) {
    Messages.update({_id: {$in: ids}}, {$set: {approved: true}})

    Meteor.call('switchboard', ids)
  }
})

Meteor.methods({
  sendMessageReply: function(message, pledgeId, group, conversationId) {
    var receiver = Conversations.findOne({_id: conversationId}).members
    Conversations.update({_id: conversationId}, {$set: {lastMessage: new Date()}})
    Messages.insert({
      pledgeId: pledgeId,
      conversationId: conversationId,
      sender: this.userId,
      receiver: receiver,
      type: 'broadcast',
      text: message,
      image: null,
      method: ['allforone'],
      time: new Date(),
      approved: true,
      rejected: false,
      group: group,
      seen: [this.userId]
    })
  }
})

Meteor.methods({
  switchboard: function(messageIds) {
    this.unblock()
    messageIds.forEach((id) => {
      var message = Messages.findOne({_id: id})
      var subtitle = message.text
      var image = message.image
      var url = Meteor.settings.ROOT_URL + '/pages/pledges/' + message.pledgeId
      var title = Pledges.findOne({_id: message.pledgeId}).title
      var pledgeSlug = Pledges.findOne({_id: message.pledgeId}).slug
      var receivers = message.receiver
      var FBUsers = []
      var group = message.group
      var OneSignalUsers = []
      var EmailUsers = []
      var TextUsers = []
      var methodFilter
      var counter = 0
      var conversationId = message.conversationId

      if (message.method.includes('messenger')) {
        var Cursor = Meteor.users.find({_id: {$in:receivers}, userMessengerId: {$exists: true}}).fetch()
        for (var i in Cursor) {
          FBUsers.push(Cursor[i]._id)
        }
        counter += 1
        Meteor.call('sendToFBUsers', FBUsers, subtitle, image, url, title)
      }
      if (message.method.includes('push')) {
        if (counter == 0) {
          var Cursor = Meteor.users.find({_id: {$in: receivers}, oneSignalUserId: {$exists: true}}).fetch()
          for (var i in Cursor) {
            PushUsers.push(Cursor[i]._id)
          }
        } else {
          var Cursor = Meteor.users.find({_id: {$in: receivers}
            , oneSignalUserId: {$exists: true}, userMessengerId: {$exists: false}}).fetch()
          for (var i in Cursor) {
            PushUsers.push(Cursor[i]._id)
          }
        }
        counter += 1
        Meteor.call('sendToPushUsers', PushUsers, subtitle, image, url, title)
      }
      if (message.method.includes('sms')) {
        if (counter == 0) {
          var Cursor = Meteor.users.find({_id: {$in: receivers}, 'profile.phone': {$exists: true}}).fetch()
          for (var i in Cursor) {
            TextUsers.push(Cursor[i]._id)
          }
        } else {
          var Cursor = Meteor.users.find({_id: {$in: receivers}, 'profile.phone': {$exists: true}
        , oneSignalUserId: {$exists: false}, userMessengerId: {$exists: false}}).fetch()
          for (var i in Cursor) {
            TextUsers.push(Cursor[i]._id)
          }
        }
        counter += 1
        Meteor.call('sendToSMSUsers', TextUsers, subtitle, image, url, title)
      }
      if (message.method.includes('email')) {
        var Cursor = Meteor.users.find({_id: {$in: receivers}, 'profile.email': {$exists: true}}).fetch()
        for (var i in Cursor) {
          EmailUsers.push(Cursor[i]._id)
        }
        Meteor.call('sendToEmailUsers', EmailUsers, subtitle, image, url, title, pledgeSlug, group, conversationId)
      }

    })
  }
})

Meteor.methods({
  addEmailReplyToThread: function(text, senderEmail, recipientEmail, threadTopic, mailgunId) {
    console.log(mailgunId)
    console.log('Sender Email' : senderEmail)
    var sender = Meteor.users.findOne({$or: [{'profile.email' : senderEmail}, {'services.facebook.email': senderEmail}]})._id
    var conversation = Conversations.findOne({mailgunIds: mailgunId })
    console.log(conversation)
    var strippedText = text.replace(' Sent from Mail<https://go.microsoft.com/fwlink/?LinkId=550986> for Windows 10', '')
    var pledgeId = conversation.pledgeId
    var receiver = conversation.members
    var methods = ['email']
    var pledgeTitle = Pledges.findOne({_id: pledgeId}).title
    var group = conversation.group

    Conversations.update({_id: conversation._id}, {$set: {lastMessage: new Date()}})
    Messages.insert({
      pledgeId: pledgeId,
      sender: sender,
      conversationId: conversation._id,
      receiver: receiver,
      type: 'reply',
      text: strippedText,
      image: null,
      method: methods,
      time: new Date(),
      approved: true,
      rejected: false,
      group: group
    })
  }
})

Meteor.methods({
  checkForFBReply: function(text, messengerId) {
    var userId = Meteor.users.findOne({userMessengerId: messengerId})._id
    console.log(userId)
    var latestMessage = Messages.find({receiver: userId, method: 'messenger'}, {sort: {time: -1}, limit: 1}).fetch()[0]
    console.log(latestMessage)
    var conversation = Conversations.findOne({conversationId: latestMessage.conversationId})
    var conversationId = conversation._id
    if (latestMessage) {
      var pledgeId = latestMessage.pledgeId
      var group = latestMessage.group
      var receiver = conversation.members
      var methods = ['messenger']

      Conversations.update({_id: conversationId}, {$set: {lastMessage: new Date()}})
      Messages.insert({
        pledgeId: pledgeId,
        sender: userId,
        conversationId: conversationId,
        receiver: receiver,
        type: 'reply',
        text: text,
        image: null,
        method: methods,
        time: new Date(),
        approved: true,
        rejected: false,
        group: group,
        seen: [userId],
      })
    }

  }
})

Meteor.methods({
  sendToFBUsers: function(userIds, subtitle, image, url, title) {
    userIds.forEach((userId) => {
      var PSID = Meteor.users.findOne({_id: userId}).userMessengerId
      var messageData = {
        recipient: {
          id: PSID
        },
        message: {
          "attachment":{
        "type":"template",
        "payload":{
          "template_type":"generic",
          "elements":[
             {
              "title":title,
              "image_url": image,
              "subtitle": subtitle,
              "default_action": {
                "type": "web_url",
                "url": url,
                "messenger_extensions": true,
                "webview_height_ratio": "tall",
                "fallback_url": url
              },
              "buttons":[
                {
                  "type":"web_url",
                  "url": url,
                  "title": 'View Pledge'
                }
              ]
            }
          ]
        }
      }
        }
      };

      callSendAPI(messageData)
    })
  }
})

Meteor.methods({
  sendToPushUsers: function(userIds, subtitle, image, url, title) {
    userIds.forEach((userId) => {
      var PushID = Meteor.users.findOne({_id: userId}).oneSignalUserId
      // Send to One Signal API call in here
    })
  }
})

var api_key = Meteor.settings.public.MailgunAPIKey;
var domain = 'allforone.io';
var mailgun = require('mailgun-js')({apiKey: api_key, domain: domain});

Meteor.methods({
  sendToEmailUsers: function(userIds, subtitle, image, url, title, pledgeSlug, group, conversationId) {

    var html = `
      <div>
        <img style="width:100%,height:auto" src=`+ image + `>
        </img>
        <p style="width:80%,text-align:center">
          ` + subtitle + `
        </p>
        <p style="width:80%,text-align:center">
        If you reply to this email, the pledge organiser will see it as a message
        </p>
      </div>
    `

    userIds.forEach((userId) => {
      var email = Meteor.users.findOne({_id: userId}).profile.email

      var data = {
          from: title + ' <' + pledgeSlug + '@allforone.io>',
          to: email,
          subject: title + ': ' + group,
          html: html,
          text: subtitle
        };


      try {
        mailgun.messages().send(data, Meteor.bindEnvironment(function (error, body) {
          mailgun.post('/routes',
          {expression: 'match_header("In-Reply-To", ".*'+ body.id +'")',
              action: ['forward("https://www.allforone.io/api/mailgun")',
              'forward("https://allforone.eu.meteorapp.com/api/mailgun")'],
            description: 'Replying',
          priority: 1}, function(error, body) {
                if (error) {
                  console.log('Error in adding route')
                  console.log(error)
                } else {
                  console.log(body)
                }
              })
          Conversations.update({_id: conversationId}, {$addToSet: {
            mailgunIds: body.id
          }})
          console.log(body.id)
        }));
      } catch(err) {
        console.log('Error in sending message')
        console.log(err)
      }
    })
  }
})

Meteor.methods({
  sendToSMSUsers: function(userIds, subtitle, image, url, title) {
    userIds.forEach((userId) => {
      var phoneNo = Meteor.users.findOne({_id: userId}).profile.phone
      // Send to Twilio API call in here
    })
  }
})

Meteor.methods({

})
